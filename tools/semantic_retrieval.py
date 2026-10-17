#!/usr/bin/env python3
"""Build and inspect a prototype semantic table index.

The index is separate from Normalized and the API. It measures lexical,
semantic, and merged retrieval before the production planner changes.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

API_URL = "https://api.openai.com/v1/embeddings"
MODEL = "text-embedding-3-small"
DIMENSIONS = 512
MAX_DOCUMENT_CHARS = 12_000
BATCH_SIZE = 32
STOPWORDS = {"a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"}


def unique_parts(value: object) -> list[str]:
    if isinstance(value, list):
        parts = (str(item).strip() for item in value)
    else:
        parts = (part.strip() for part in str(value or "").split(" | "))
    return list(dict.fromkeys(part for part in parts if part))


def compact_document(row: dict[str, object], limit: int = MAX_DOCUMENT_CHARS,
                     details: bool = True) -> str:
    """Keep semantic identity first; lexical search retains every full member label."""
    text = "\n".join([
        f"Title: {row.get('title_en') or ''}",
        f"Concepts: {'; '.join(unique_parts(row.get('concepts')))}",
        f"Subjects: {'; '.join(unique_parts(row.get('subject_en')))}",
        f"Surveys: {'; '.join(unique_parts(row.get('survey_en')))}",
        f"Dimensions: {'; '.join(unique_parts(row.get('search_dimensions')))}",
    ])
    if not details:
        return text[:limit]
    for label, value in (("Notes", row.get("search_notes")), ("Members", row.get("search_members"))):
        remaining = limit - len(text) - len(label) - 3
        if remaining <= 0:
            break
        content = "; ".join(unique_parts(value))[:remaining]
        if content:
            text += f"\n{label}: {content}"
    return text[:limit]


def concept_text(path: Path) -> dict[str, list[str]]:
    by_pid: dict[str, list[str]] = {}
    with path.open(newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            text = f"{row['label']}: {row['description']}"
            for pid in row["pids"].split(";"):
                by_pid.setdefault(pid, []).append(text)
    return by_pid


def table_rows(table_file: Path, concepts_file: Path | None) -> list[dict[str, object]]:
    con = duckdb.connect()
    try:
        columns = "pid, title_en, subject_en, survey_en, search_dimensions, search_members, search_notes"
        result = con.execute(
            f"SELECT {columns} FROM read_parquet(?) WHERE queryable ORDER BY pid", [str(table_file)]
        )
        names = [item[0] for item in result.description]
        concepts = concept_text(concepts_file) if concepts_file else {}
        records = [dict(zip(names, row)) for row in result.fetchall()]
        for record in records:
            record["concepts"] = concepts.get(str(record["pid"]), [])
        return records
    finally:
        con.close()


def embed(inputs: list[str], key: str, model: str, dimensions: int) -> list[list[float]]:
    body = json.dumps({
        "model": model, "input": inputs, "encoding_format": "float", "dimensions": dimensions,
    }).encode()
    request = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        "User-Agent": "statcan2-semantic-retrieval/0.1",
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.load(response)
            ordered = sorted(result["data"], key=lambda item: item["index"])
            vectors = [item["embedding"] for item in ordered]
            if len(vectors) != len(inputs) or any(len(vector) != dimensions for vector in vectors):
                raise ValueError("embedding response shape does not match the request")
            return vectors
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 529) or attempt == 3:
                message = error.read(1000).decode("utf-8", "replace")
                raise RuntimeError(f"embedding API HTTP {error.code}: {message}") from error
        except (TimeoutError, urllib.error.URLError):
            if attempt == 3:
                raise
        time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def write_index(path: Path, records: dict[str, dict[str, object]]) -> None:
    rows = [records[pid] for pid in sorted(records)]
    table = pa.Table.from_pylist(rows, schema=pa.schema([
        ("pid", pa.string()), ("document_sha256", pa.string()), ("model", pa.string()),
        ("dimensions", pa.int32()), ("embedding", pa.list_(pa.float32())),
    ]))
    temporary = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(table, temporary, compression="zstd")
    temporary.replace(path)


def build(args: argparse.Namespace) -> None:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY is required")
    rows = table_rows(args.normalized / "table.parquet", args.concepts)
    existing: dict[str, dict[str, object]] = {}
    if args.output.exists():
        existing = {row["pid"]: row for row in pq.read_table(args.output).to_pylist()
                    if row["model"] == args.model and row["dimensions"] == args.dimensions}
    pending: list[tuple[str, str, str]] = []
    for row in rows:
        document = compact_document(row, args.max_chars, details=args.document == "full")
        digest = hashlib.sha256(document.encode()).hexdigest()
        if existing.get(row["pid"], {}).get("document_sha256") != digest:
            pending.append((str(row["pid"]), digest, document))
    print(f"tables={len(rows)} reusable={len(rows) - len(pending)} pending={len(pending)}")
    for start in range(0, len(pending), args.batch_size):
        batch = pending[start:start + args.batch_size]
        vectors = embed([item[2] for item in batch], key, args.model, args.dimensions)
        for (pid, digest, _), vector in zip(batch, vectors):
            existing[pid] = {"pid": pid, "document_sha256": digest, "model": args.model,
                             "dimensions": args.dimensions, "embedding": vector}
        if start % (args.batch_size * 10) == 0 or start + len(batch) == len(pending):
            write_index(args.output, existing)
            print(f"embedded={min(start + len(batch), len(pending))}/{len(pending)}")


def cosine(a: list[float], b: list[float]) -> float:
    denominator = math.sqrt(sum(x * x for x in a) * sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / denominator if denominator else 0.0


def load_indices(paths: list[Path]) -> tuple[list[list[dict[str, object]]], str, int]:
    indices = [pq.read_table(path).to_pylist() for path in paths]
    if any(not rows for rows in indices):
        raise SystemExit("embedding index is empty")
    models = {(rows[0]["model"], rows[0]["dimensions"]) for rows in indices}
    if len(models) != 1:
        raise SystemExit("embedding indexes must use the same model and dimensions")
    model, dimensions = models.pop()
    return indices, str(model), int(dimensions)


def rank_vector(rows: list[dict[str, object]], vector: list[float], limit: int) -> list[tuple[str, float]]:
    return sorted(((str(row["pid"]), cosine(vector, row["embedding"])) for row in rows),
                  key=lambda item: item[1], reverse=True)[:limit]


def lexical_rank(table_file: Path, query: str, limit: int) -> list[tuple[str, float]]:
    terms = [term for term in re.findall(r"[^\W_]+", query.lower(), re.UNICODE)
             if term not in STOPWORDS][:8]
    if not terms:
        return []
    patterns = [rf"(^|[^[:alnum:]]){re.escape(term)}([^[:alnum:]]|$)" for term in terms]
    title = " + ".join("regexp_matches(lower(search_title), ?)::INT" for _ in terms)
    matches = " + ".join("regexp_matches(lower(search_text), ?)::INT" for _ in terms)
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT pid, title_hits * 4 + text_hits AS score FROM ("
            f"SELECT pid, title_en, {title} AS title_hits, {matches} AS text_hits "
            f"FROM read_parquet(?) WHERE queryable) "
            f"WHERE text_hits > 0 ORDER BY score DESC, title_hits DESC, title_en, pid LIMIT ?",
            [*patterns, *patterns, str(table_file), limit],
        ).fetchall()
        return [(pid, float(score)) for pid, score in rows]
    finally:
        con.close()


def reciprocal_rank_fusion(*rankings: list[tuple[str, float]], k: int = 60,
                           weights: list[float] | None = None) -> list[tuple[str, float]]:
    scores: dict[str, float] = {}
    if weights is None:
        weights = [1.0] * len(rankings)
    if len(weights) != len(rankings):
        raise ValueError("one fusion weight is required per ranking")
    for ranking, weight in zip(rankings, weights):
        for rank, (pid, _) in enumerate(ranking, 1):
            scores[pid] = scores.get(pid, 0.0) + weight / (k + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


def query(args: argparse.Namespace) -> None:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY is required")
    table_file = args.normalized / "table.parquet"
    indices, model, dimensions = load_indices(args.index)
    vector = embed([args.query], key, model, dimensions)[0]
    semantics = [rank_vector(rows, vector, args.candidates) for rows in indices]
    lexical = lexical_rank(table_file, args.query, args.candidates)
    merged = reciprocal_rank_fusion(lexical, *semantics, weights=[1, *([2] * len(semantics))])[:args.limit]
    con = duckdb.connect()
    try:
        titles = dict(con.execute("SELECT pid, title_en FROM read_parquet(?)", [str(table_file)]).fetchall())
    finally:
        con.close()
    rankings = [("lexical", lexical[:args.limit]), *[(f"semantic:{path.stem}", ranking[:args.limit])
                for path, ranking in zip(args.index, semantics)], ("merged", merged)]
    for name, ranking in rankings:
        print(f"\n{name}")
        for rank, (pid, score) in enumerate(ranking, 1):
            print(f"{rank:2}  {score:.6f}  {pid}  {titles.get(pid, '')}")


def evaluate(args: argparse.Namespace) -> None:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY is required")
    with args.cases.open(newline="", encoding="utf-8") as source:
        cases = list(csv.DictReader(source))
    indices, model, dimensions = load_indices(args.index)
    vectors = embed([case["query"] for case in cases], key, model, dimensions)
    semantic_names = [f"semantic:{path.stem}" for path in args.index]
    methods: dict[str, list[int | None]] = {"lexical": [], **{name: [] for name in semantic_names}, "merged": []}
    table_file = args.normalized / "table.parquet"
    for case, vector in zip(cases, vectors):
        expected = set(case["acceptable_pids"].split(";"))
        lexical = lexical_rank(table_file, case["query"], args.candidates)
        semantics = [rank_vector(rows, vector, args.candidates) for rows in indices]
        ranked = {
            "lexical": lexical,
            **dict(zip(semantic_names, semantics)),
            "merged": reciprocal_rank_fusion(lexical, *semantics, weights=[1, *([2] * len(semantics))]),
        }
        for name, ranking in ranked.items():
            hit = next((i for i, (pid, _) in enumerate(ranking, 1) if pid in expected), None)
            methods[name].append(hit)
            if name == "merged" and (hit is None or hit > 12):
                print(f"MISS merged query={case['query']!r} expected={sorted(expected)} rank={hit}")
    for name, ranks in methods.items():
        metrics = " ".join(f"R@{k}={sum(rank is not None and rank <= k for rank in ranks)}/{len(ranks)}"
                           for k in (1, 5, 12, 100))
        reciprocal = sum(1 / rank for rank in ranks if rank) / len(ranks)
        print(f"{name:8} {metrics} MRR={reciprocal:.3f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--normalized", required=True, type=Path)
    build_parser.add_argument("--output", required=True, type=Path)
    build_parser.add_argument(
        "--concepts", type=Path,
        help="optional concept labels and descriptions to add to each table document",
    )
    build_parser.add_argument("--model", default=MODEL)
    build_parser.add_argument("--dimensions", type=int, default=DIMENSIONS)
    build_parser.add_argument("--max-chars", type=int, default=MAX_DOCUMENT_CHARS)
    build_parser.add_argument("--document", choices=("identity", "full"), default="identity")
    build_parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    build_parser.set_defaults(run=build)
    query_parser = commands.add_parser("query")
    query_parser.add_argument("query")
    query_parser.add_argument("--normalized", required=True, type=Path)
    query_parser.add_argument("--index", required=True, type=Path, action="append")
    query_parser.add_argument("--limit", type=int, default=12)
    query_parser.add_argument("--candidates", type=int, default=50)
    query_parser.set_defaults(run=query)
    eval_parser = commands.add_parser("evaluate")
    eval_parser.add_argument("--normalized", required=True, type=Path)
    eval_parser.add_argument("--index", required=True, type=Path, action="append")
    eval_parser.add_argument("--cases", required=True, type=Path)
    eval_parser.add_argument("--candidates", type=int, default=100)
    eval_parser.set_defaults(run=evaluate)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
