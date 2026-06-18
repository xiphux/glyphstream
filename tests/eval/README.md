# Evaluation harnesses

On-demand quality measurements — **not** part of `pnpm test`.

Unlike the hermetic unit suite, evals here:

- hit the **live** endpoints configured in `config.toml` (`[embeddings]`,
  `[rerank]`), so they measure _your actual setup_;
- are non-deterministic and slow (network round-trips);
- **measure** rather than assert pass/fail — the value is the printed report.

They live under their own config (`vitest.eval.config.ts`, include glob
`tests/eval/**/*.eval.ts`) so they never run in CI or `pnpm test`.

## Run

```sh
pnpm eval
```

## Harnesses

- **`reranker-answer-presence.eval.ts`** — drives the `fetch_url` relevance
  pipeline (`selectRelevant`) over a set of `(page, find-query, answer-span)`
  fixtures under three configs (BM25 only / +embedding / +rerank) and reports
  **answer-presence rate** — did the known answer survive into the packed
  budget. The budget is held tight so only ~1 section fits, making the metric a
  sharp test of ranking quality. Use it to confirm a reranker model actually
  helps (and doesn't regress) before trusting it in production.

## Reading the numbers honestly

- Hand-authored fixtures and small N give **direction, not significance**. A
  real verdict wants a broader, realistic set.
- The metric targets **needle-finding**, which is what the feature is for; it
  says nothing about whole-doc synthesis.
- A reranker's own confidence scores are not evidence — only labeled outcomes
  (answer-presence) count. If `embed`/`rerank` columns show no lift over `bm25`
  on a given set, that's a real result, not a bug.
