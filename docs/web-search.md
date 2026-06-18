# Web search & RAG

Two built-in tools give the model web reach:

- **`web_search`** — query a self-hosted [SearxNG](https://docs.searxng.org/)
  meta-search instance. The model decides when a query needs current
  information (events past its training cutoff, recent docs, specific URLs
  to read) and calls it on its own — no per-conversation "enable search"
  toggle.
- **`fetch_url`** — read a single web page or text resource by URL, with
  article extraction and relevance-based selection for long pages.

The `web_search` tool is **hidden from the model entirely** when SearxNG
isn't configured, so omitting the `[search]` block soft-disables the feature
without breaking anything else. The paired `fetch_url` tool is **always
available** — useful when you want the model to read a specific link, with
or without search.

Both tools share the `web` per-conversation toggle — see
[feature toggles](tools.md#per-conversation-feature-toggles).

## Setting up web search

**1.** Run a SearxNG instance. The official Docker image is the easy path:

```bash
docker run -d --name searxng -p 8888:8080 searxng/searxng
```

**2.** Enable the JSON output format in SearxNG's `settings.yml` (the
default config only enables HTML):

```yaml
search:
  formats:
    - html
    - json
```

Restart the container after editing.

**3.** Add a `[search]` block to your `config.toml`:

```toml
[search]
url = "http://192.168.1.10:8888"
# api_key_env = "SEARXNG_API_KEY"   # optional; most instances need no auth
# timeout_seconds = 10              # optional; default 10
```

That's it — `web_search` is now in every tool-capable endpoint's advertised
toolset. The capability-named `[search]` section reserves the namespace for
future backend swaps (Brave, Tavily, Kagi) without breaking existing
configs.

## `fetch_url` extraction

HTML pages are extracted with Mozilla's
[Readability](https://github.com/mozilla/readability) (the same algorithm
Firefox Reader View uses), which strips site chrome, navigation, sidebars,
comments, and ads down to just the article body plus its title — typically
5-10x smaller than the raw page, and much friendlier to the model's context.
Pages Readability can't identify as articles (search-result pages, directory
indexes) fall through to a coarser regex stripper. Raw response bodies are
capped at 2 MB; the final extracted text is capped at ~20 KB.

**Safety note:** to mitigate the model hallucinating an internal URL (or
following a redirect into one), `fetch_url` blocks hostnames that resolve to
private, loopback, link-local, CGNAT, benchmark, multicast, or
cloud-metadata addresses (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x,
IPv6 ULA/link-local, etc.). Operators who want to point the model at LAN
services aren't supported today; open an issue if you have a real use case.

## Long pages: relevance selection

`fetch_url` accepts an optional `find` argument — a plain-language note of
what the model is looking for on the page. It only matters for long pages:
when the extracted text exceeds the ~20 KB budget, instead of blindly
keeping the first 20 KB, GlyphStream selects the **most relevant sections**
and returns those (in document order). The result's `mode` field reports
which path ran — `full` (page fit within budget), `truncated` (over budget,
no `find`), or `relevance` (over budget, `find`-driven selection).

Selection is hybrid retrieval over the page's own structure:

- The article is chunked on its heading/paragraph boundaries, and each chunk
  is prefixed with a breadcrumb (`Page Title › Section › Subsection`) so a
  retrieved mid-document chunk keeps its context.
- **BM25** (lexical) scores every chunk — always on, no configuration, great
  for exact/rare terms (API names, error codes, identifiers).
- **Embedding cosine** (semantic) is added _when an `[embeddings]` model is
  configured_, and the two rankings are fused with Reciprocal Rank Fusion.
  This catches paraphrase matches BM25 misses (a query about "failures"
  matching a section titled "Resilience").

Without `[embeddings]`, selection runs BM25-only — still far better than
positional truncation. If the embedding endpoint is unreachable, slow, or
returns something malformed, selection silently **falls back to BM25**; it
never turns a fetch into an error.

On the `relevance` path the result also carries two breadcrumb lists:
`sections` (the section trails actually returned in `content`) and `outline`
(every section in the full page). Together they turn a single lookup into
**multi-hop reading**: the model sees what it got _and_ what else the page
holds, so when the answer isn't in the returned sections it can re-fetch the
same URL with a different `find` aimed at a section from `outline` — rather
than flying blind. Both are omitted on the `full`/`truncated` paths and on
pages with no heading structure.

## The `[embeddings]` block

To enable the embedding leg, add an `[embeddings]` block naming an existing
endpoint and an embedding model:

```toml
[embeddings]
endpoint_id = "nas-bridge"        # one of your [[endpoints]] ids
model_id = "text-embedding-3-small"
# timeout_seconds = 30            # optional; default 30
# max_input_tokens = 512          # optional; default 512 — the model's max
#                                 # input length; each embedded text is
#                                 # truncated to fit. Raise for big-context
#                                 # models (e.g. 8192).
# query_prefix = ""               # optional; default "". nomic/e5/bge/gte
# document_prefix = ""            # need "search_query: "/"search_document: ";
#                                 # OpenAI/Cohere-style models must NOT.
```

base_url and auth are inherited from the referenced endpoint. A bad
`endpoint_id` quietly disables embeddings (degrades to BM25) rather than
failing at boot. The block is capability-named rather than `fetch_url`-specific:
it also powers **`recall_memory`**, the semantic search over a user's saved
memories. With it configured, a background worker embeds saved memories and the
model retrieves the relevant ones on demand instead of carrying the whole index
in every system prompt (see [Tools](tools.md)). Without it, memory falls back to
inlining all saved facts, and `fetch_url` to BM25-only — both still work.

> **Throughput matters.** Embedding dozens of chunks per long-page fetch is
> only practical on a reasonably fast embedding endpoint (GPU-backed, or a
> hosted provider). A slow CPU embedder will routinely exceed
> `timeout_seconds` and fall back to BM25 — which is fine, just not the
> hybrid path. BM25-only is the sensible mode when no fast embedder is
> available.

## The `[rerank]` block (optional reranker)

Hybrid retrieval gets the right sections into the candidate set; a **reranker**
reorders that set by judging each candidate's relevance _jointly_ with the
query, which a bag-of-features retriever (BM25 ⊕ embedding cosine) can't. When a
`[rerank]` block is configured, `fetch_url` reranks the top candidates of the
fused ranking before packing them to the budget — so the sections that actually
fit are the most relevant ones, not just the highest lexical/semantic hits. It's
the largest quality gain after hybrid retrieval and is purely additive: without
the block, selection uses the fused order as before.

```toml
[rerank]
endpoint_id = "local-rerank"      # one of your [[endpoints]] ids
model_id = "bge-reranker-v2-m3"
# timeout_seconds = 30            # optional; default 30
# top_n = 20                      # optional; default 20 — how many of the top
#                                 # fused candidates to rerank (cost ceiling)
# quirk = "tei"                   # optional; wire-shape variant (see below)
```

base_url and auth are inherited from the referenced endpoint. Like
`[embeddings]`, a bad `endpoint_id` quietly disables reranking (selection keeps
the fused order) rather than failing at boot, and any failure at request time —
endpoint down, timeout, malformed response — **falls back to the fused order**;
reranking never turns a fetch into an error.

> **Use a cross-encoder, not a chat model.** This wants a purpose-trained
> reranker (`/rerank`-style endpoint), not a general LLM. A small cross-encoder
> like **bge-reranker-v2-m3 (~568M)** _outperforms a 7B general model_ at this
> task while being far cheaper and faster — it's trained for exactly the
> query-document scoring reranking needs. Stand one up on llama.cpp
> (`--reranking`), Hugging Face TEI, Infinity, or vLLM. A general instruct model
> can do listwise reranking, but only competently from ~7B up, so a dedicated
> cross-encoder is both leaner and better here.

### Wire shape & the `tei` quirk

The default speaks the **Cohere/Jina** rerank shape — `POST {endpoint}/rerank`
with `{ model, query, documents, top_n }`, returning
`{ results: [{ index, relevance_score }] }` — which vLLM, llama.cpp, Infinity,
Jina, and Cohere all implement. **Hugging Face TEI** diverges (sends `texts`,
returns a bare `[{ index, score }]` array, and serves `/rerank` at the server
root rather than under `/v1`); set `quirk = "tei"` to opt into that variant.
