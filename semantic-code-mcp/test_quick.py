#!/usr/bin/env python3
"""快速验证 test-file deprioritization 效果。"""
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

from embedder import Embedder
from indexer import Indexer
from retriever import Retriever
from store import CodeStore
import hashlib, os

TARGET = r"D:\project\main\CLIProxyAPI"

db_dir = os.getenv("SCM_DB_DIR") or str(Path.home() / ".semantic-code-mcp")
Path(db_dir).mkdir(parents=True, exist_ok=True)
dtype = os.getenv("SCM_EMBED_DTYPE", "float")
h = hashlib.sha256(f"{TARGET}|{dtype}".encode()).hexdigest()[:16]
db_path = str(Path(db_dir) / f"{h}.db")

embedder = Embedder()
store = CodeStore(db_path, embedder.dim, dtype=dtype)
retriever = Retriever(store, embedder)

# 只检索（用已有索引）
q = "round-robin load balancing across multiple provider backends"
print(f"Query: {q}\n")
results = retriever.search(q, top_k=100, top_n=5, expand_graph=False)
for i, r in enumerate(results, 1):
    is_test = retriever._is_test_file(r.get("file_path", ""))
    marker = " [TEST]" if is_test else ""
    print(f"  {i}. {Path(r['file_path']).name} :: {r['symbol']} (score={r.get('score',0):.3f}){marker}")

store.close()
