"""检索层：向量 + BM25 hybrid 召回，RRF 融合，Cohere rerank 重排，意图感知打分。

流程：query -> 向量召回 + BM25 召回 -> RRF 融合 -> (可选)rerank
      -> 调用链意图直查 edges 置顶 -> 测试/barrel/非代码降权（测试与文档意图反转为 boost）
      -> 符号/文件名 boost -> 文件多样性截断 -> call graph 图扩展
未配置 COHERE_API_KEY 时自动跳过 rerank，直接使用 RRF 融合分数。
"""
from __future__ import annotations

import os
import re

from embedder import Embedder
from expander import create_expander
from store import CodeStore

try:
    import cohere
except Exception:  # 依赖缺失不阻断
    cohere = None


# RRF 融合常数，经验值 60
_RRF_K = 60
# 送入 rerank 的单文档最大字符数
_RERANK_DOC_MAX_CHARS = 4000
# 测试文件 score 惩罚系数（实现优先于测试）
_TEST_FILE_PENALTY = 0.5
# 测试文件名模式
_TEST_PATTERNS = ("_test.", "test_", "Test.", ".test.", ".spec.", "_spec.")
# 查询中完整命中符号名时的 boost（如查询里直接写了函数名）
_SYMBOL_EXACT_BOOST = 1.5
# 符号/文件名分词与查询 token 每命中一个的 boost 增量（最多计 3 个）
_NAME_TOKEN_BOOST = 0.1
# top_n 结果中同一文件最多保留的块数（文件多样性）
_MAX_PER_FILE = 2
# barrel / 纯导出入口文件降权（实现文件优先于 re-export 入口）
_BARREL_PENALTY = 0.85
# 非代码文件（文档/配置）温和降权：分数接近时实现代码优先，不影响文档类查询的大分差命中
_NON_CODE_PENALTY = 0.8
_NON_CODE_LANGS = {"markdown", "yaml", "json", "toml", "properties", "text"}
_BARREL_NAMES = {"index.ts", "index.js", "index.tsx", "index.jsx", "index.mjs", "__init__.py", "mod.rs"}
# 调用链意图："谁调用/被哪些...调用/who calls/callers of"
_CALLER_INTENT_RE = re.compile(
    r"(谁调用|被哪些|哪些[^\s]{0,8}调用|调用了?它|callers?\s+of|who\s+calls|call\s*sites?)", re.I
)
# 测试意图：查询本身在找测试/基准 -> 反转测试降权为 boost
_TEST_INTENT_RE = re.compile(r"(\btests?\b|\bspec\b|benchmark|单测|测试|用例|基准)", re.I)
_TEST_INTENT_BOOST = 1.2
# 文档意图：查询在找架构/规范/文档 -> 反转非代码降权为 boost
_DOC_INTENT_RE = re.compile(
    r"(architect|overview|convention|guideline|readme|documentation|\bdocs?\b|规范|架构|职责|约定|文档|说明)", re.I
)
_DOC_INTENT_BOOST = 1.5
# 配置意图：查询在找配置项/schema -> 配置类文件（yaml/toml/properties/json）反转为 boost
_CONFIG_INTENT_RE = re.compile(r"(config|configuration|settings|\byaml\b|\btoml\b|配置)", re.I)
_CONFIG_LANGS = {"yaml", "toml", "properties", "json"}
_CONFIG_INTENT_BOOST = 1.4


class Retriever:
    """混合检索器。"""

    def __init__(
        self,
        store: CodeStore,
        embedder: Embedder,
        rerank_api_key: str | None = None,
        rerank_model: str = "rerank-v3.5",
        expander=None,
    ) -> None:
        self.store = store
        self.embedder = embedder
        self.rerank_model = rerank_model
        key = rerank_api_key or os.getenv("COHERE_API_KEY")
        self.cohere_client = cohere.Client(key) if (key and cohere) else None
        # 查询扩展（HyDE + 多查询变体）：默认按 SCM_QUERY_EXPANSION 开关创建
        self.expander = expander if expander is not None else create_expander()

    @staticmethod
    def _is_test_file(file_path: str) -> bool:
        """判断是否是测试文件。"""
        name = file_path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        return any(p in name for p in _TEST_PATTERNS)

    @staticmethod
    def _is_barrel_file(file_path: str) -> bool:
        """判断是否是 barrel / 纯入口文件。"""
        name = file_path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        return name in _BARREL_NAMES

    @staticmethod
    def _noncode_mult(language: str, doc_intent: bool, config_intent: bool) -> float:
        """非代码文件的意图感知乘数：文档意图 > 配置意图 > 默认降权。"""
        if language not in _NON_CODE_LANGS:
            return 1.0
        if doc_intent:
            return _DOC_INTENT_BOOST
        if config_intent and language in _CONFIG_LANGS:
            return _CONFIG_INTENT_BOOST
        return _NON_CODE_PENALTY

    @staticmethod
    def _intent_symbols(query: str) -> list[str]:
        """从调用链意图查询中提取代码标识符（camelCase / snake_case）。"""
        out: list[str] = []
        for ident in re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", query):
            if "_" in ident or re.search(r"[a-z][A-Z]", ident):
                out.append(ident)
        return out

    def _caller_intent_hits(self, query: str) -> list[dict]:
        """调用链意图：命中意图模式时直查 edges 表，结构化结果置顶。"""
        if not _CALLER_INTENT_RE.search(query):
            return []
        hits: list[dict] = []
        seen: set[int] = set()
        for ident in self._intent_symbols(query):
            # PascalCase 类名同时按实例字段命名约定查一次
            # （Java/Spring: SignsValueEvaluator -> signsValueEvaluator，edges 记录的是接收者名）
            names = [ident]
            if ident[:1].isupper():
                names.append(ident[:1].lower() + ident[1:])
            for name in names:
                for ch in self.store.callers_of(name):
                    if ch["id"] in seen:
                        continue
                    seen.add(ch["id"])
                    ch = dict(ch)
                    ch["score"] = 9.99  # 结构化命中，排在所有语义结果之前
                    hits.append(ch)
        return hits

    @staticmethod
    def _ident_parts(name: str) -> list[str]:
        """把标识符拆成小写分词（camelCase / snake_case 兼容）。"""
        s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name or "")
        return [p for p in re.findall(r"[a-z0-9]+", s.lower()) if len(p) >= 2]

    @classmethod
    def _query_tokens(cls, query: str) -> set[str]:
        """提取查询中的标识符 token（含整词与分词）。"""
        tokens: set[str] = set()
        for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", query):
            tokens.add(w.lower())
            tokens.update(cls._ident_parts(w))
        return tokens

    def _name_boost(self, qtokens: set[str], chunk: dict) -> float:
        """名称信号 boost：符号完整命中强提升；符号/文件名分词命中按个数提升。"""
        if not qtokens:
            return 1.0
        symbol = chunk.get("symbol") or ""
        sym_parts = self._ident_parts(symbol)
        flat = "".join(sym_parts)
        if flat and flat in qtokens:
            return _SYMBOL_EXACT_BOOST
        fp = chunk.get("file_path") or ""
        stem = fp.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].split(".")[0]
        matched = len((set(sym_parts) | set(self._ident_parts(stem))) & qtokens)
        return 1.0 + _NAME_TOKEN_BOOST * min(matched, 3)

    def search(
        self,
        query: str,
        top_k: int = 100,
        top_n: int = 10,
        expand_graph: bool = True,
        graph_limit: int = 8,
        max_per_file: int = _MAX_PER_FILE,
    ) -> list[dict]:
        """检索并返回 top_n 个代码块（dict，含 score）。

        排序管线：向量+BM25 召回 → RRF → rerank（可选）→ 调用链意图置顶 →
        意图感知降权/boost + 名称 boost → 文件多样性截断（每文件最多 max_per_file 块）。

        expand_graph=True 时，在主结果基础上沿 call graph 扩展 1 跳，
        把调用者/被调用者作为关联结果附加（带 relation 字段）。
        """
        # 1. 向量召回 + 2. BM25 召回（原查询）
        q_emb = self.embedder.embed_query(query)
        rank_lists = [
            [cid for cid, _ in self.store.search_vector(q_emb, top_k)],
            [cid for cid, _ in self.store.search_fts(query, top_k)],
        ]
        weights = [1.0, 1.0]
        # 2.5 查询扩展（可选）：变体走 query 模式，HyDE 假想代码走 document 模式；
        #     原查询两路权重加倍，防扩展噪声稀释原始信号
        expansion = self.expander.expand(query) if self.expander else None
        if expansion:
            weights = [2.0, 2.0]
            for v in expansion.get("variants", []):
                v_emb = self.embedder.embed_query(v)
                rank_lists.append([cid for cid, _ in self.store.search_vector(v_emb, top_k)])
                weights.append(1.0)
                rank_lists.append([cid for cid, _ in self.store.search_fts(v, top_k)])
                weights.append(1.0)
            hyde = expansion.get("hyde")
            if hyde:
                h_emb = self.embedder.embed_documents([hyde])[0]
                rank_lists.append([cid for cid, _ in self.store.search_vector(h_emb, top_k)])
                weights.append(1.0)
        # 3. RRF 融合（仅用排名）
        fused = self._rrf(rank_lists, weights=weights)
        if not fused:
            return []
        cand_ids = [cid for cid, _ in fused[:top_k]]
        chunk_map = self.store.get_chunks(cand_ids)
        candidates: list[dict] = []
        for cid, rrf_score in fused[:top_k]:
            ch = chunk_map.get(cid)
            if ch:
                ch = dict(ch)
                ch["score"] = rrf_score
                candidates.append(ch)
        # 4. rerank（可选，失败降级为 RRF 分数）；多取候选给后续多样性截断留余量
        if self.cohere_client and candidates:
            try:
                rerank_n = min(len(candidates), max(top_n * 3, 20))
                candidates = self._rerank(query, candidates, rerank_n)
            except Exception:
                pass
        # 4.5 调用链意图：结构化命中注入高分（并入统一打分管线，测试调用方会被后续降权拆开）
        intent_hits = self._caller_intent_hits(query)
        if intent_hits:
            by_id = {c.get("id"): c for c in candidates}
            for h in intent_hits:
                if h["id"] in by_id:
                    by_id[h["id"]]["score"] = h["score"]
                else:
                    candidates.append(h)
        # 5. 统一后处理：意图感知的降权/boost + 符号/文件名 boost
        qtokens = self._query_tokens(query)
        test_intent = bool(_TEST_INTENT_RE.search(query))
        doc_intent = bool(_DOC_INTENT_RE.search(query))
        config_intent = bool(_CONFIG_INTENT_RE.search(query))
        for c in candidates:
            mult = 1.0
            fp = c.get("file_path", "")
            if self._is_test_file(fp):
                mult *= _TEST_INTENT_BOOST if test_intent else _TEST_FILE_PENALTY
            if self._is_barrel_file(fp):
                mult *= _BARREL_PENALTY
            mult *= self._noncode_mult(c.get("language", ""), doc_intent, config_intent)
            mult *= self._name_boost(qtokens, c)
            c["score"] *= mult
        candidates.sort(key=lambda x: x["score"], reverse=True)
        # 6. 文件多样性：同一文件最多 max_per_file 块，避免 top_n 被单文件刷屏
        results: list[dict] = []
        per_file: dict[str, int] = {}
        for c in candidates:
            fp = c.get("file_path", "")
            if max_per_file > 0 and per_file.get(fp, 0) >= max_per_file:
                continue
            per_file[fp] = per_file.get(fp, 0) + 1
            results.append(c)
            if len(results) >= top_n:
                break
        # 7. call graph 扩展（在主结果基础上连带召回调用关系）
        if expand_graph and results:
            results = self._with_graph(results, graph_limit)
        return results

    def _with_graph(self, results: list[dict], limit: int) -> list[dict]:
        """在主结果后附加 call graph 关联块（去重，带 relation 标记）。"""
        origin_ids = [r["id"] for r in results if "id" in r]
        symbols = [r.get("symbol", "") for r in results]
        related = self.store.expand_graph(origin_ids, symbols, limit=limit)
        existing = set(origin_ids)
        for r in related:
            if r["id"] in existing:
                continue
            r["score"] = 0.0  # 图扩展块无 relevance 分，靠 relation 标记
            results.append(r)
            existing.add(r["id"])
        return results

    @staticmethod
    def _rrf(
        rank_lists: list[list[int]],
        k: int = _RRF_K,
        weights: list[float] | None = None,
    ) -> list[tuple[int, float]]:
        """Reciprocal Rank Fusion：融合多个召回列表的排名（可选每路权重）。"""
        scores: dict[int, float] = {}
        for i, ranks in enumerate(rank_lists):
            w = weights[i] if weights else 1.0
            for rank, doc_id in enumerate(ranks):
                scores[doc_id] = scores.get(doc_id, 0.0) + w / (k + rank + 1)
        return sorted(scores.items(), key=lambda x: x[1], reverse=True)

    def _rerank(self, query: str, candidates: list[dict], top_n: int) -> list[dict]:
        docs = [self._doc_text(c) for c in candidates]
        resp = self.cohere_client.rerank(
            model=self.rerank_model,
            query=query,
            documents=docs,
            top_n=min(top_n, len(docs)),
        )
        out: list[dict] = []
        for r in resp.results:
            ch = dict(candidates[r.index])
            ch["score"] = float(r.relevance_score)
            out.append(ch)
        return out

    @staticmethod
    def _doc_text(chunk: dict) -> str:
        """构造送入 rerank 的文档文本（路径 + 符号 + 代码）。"""
        head = f"{chunk.get('file_path', '')} :: {chunk.get('symbol', '')}"
        return f"{head}\n{chunk.get('code', '')}"[:_RERANK_DOC_MAX_CHARS]
