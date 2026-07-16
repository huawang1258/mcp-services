#!/usr/bin/env python3
"""CLIProxyAPI 检索准确度测试。

用 5 个与项目核心架构相关的查询评估检索质量。
"""
from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

from dotenv import load_dotenv

from embedder import Embedder
from indexer import Indexer
from retriever import Retriever
from store import CodeStore

load_dotenv()

TARGET = r"D:\project\main\CLIProxyAPI"

QUERIES = [
    "OAuth authentication flow and credential acquisition",
    "round-robin load balancing across multiple provider backends",
    "thinking and reasoning pipeline configuration and normalization",
    "Codex WebSocket executor session and liveness management",
    "model registry remote updater and model definitions",
]


def main() -> None:
    db_dir = tempfile.mkdtemp(prefix="scm_cliproxy_")
    db_path = str(Path(db_dir) / "index.db")
    try:
        embedder = Embedder()
        store = CodeStore(db_path, embedder.dim)
        indexer = Indexer(TARGET, store, embedder)
        retriever = Retriever(store, embedder)
        print(f"[test] 目标: {TARGET}")
        print(f"[test] embedding: {embedder.model}, rerank: {'启用' if retriever.cohere_client else '未配置'}")
        print(f"[test] contextual embedding: ON (file_path + symbol + language prefix)")
        print(f"[test] FTS5 multi-field: ON (code + file_path + symbol)")
        print(f"[test] test file penalty: 0.7x")

        t0 = time.time()

        def _progress(done, total, fp):
            if done % 100 == 0 or done == total:
                print(f"  索引中 {done}/{total}: {Path(fp).name}")

        stats = indexer.sync(progress=_progress)
        print(f"[test] 索引完成: {time.time() - t0:.1f}s, {stats}\n")

        for q in QUERIES:
            t0 = time.time()
            results = retriever.search(q, top_k=100, top_n=5, expand_graph=True, graph_limit=5)
            elapsed = time.time() - t0
            main_results = [r for r in results if "relation" not in r]
            graph_results = [r for r in results if "relation" in r]
            print(f"=== {q}")
            print(f"  ({elapsed:.2f}s, {len(main_results)} 主 + {len(graph_results)} 图扩展)")
            for i, r in enumerate(main_results, 1):
                print(
                    f"  {i}. {Path(r['file_path']).name} :: {r['symbol']} "
                    f"(L{r['start_line']}-{r['end_line']}, score={r.get('score', 0):.3f})"
                )
            for r in graph_results:
                rel = "→被调用" if r.get("relation") == "callee" else "←调用者"
                print(
                    f"       └─[{rel}] {Path(r['file_path']).name} :: {r['symbol']} "
                    f"(L{r['start_line']}-{r['end_line']})"
                )
            print()
        store.close()
    finally:
        shutil.rmtree(db_dir, ignore_errors=True)
    print("[test] 完成。")


if __name__ == "__main__":
    main()
