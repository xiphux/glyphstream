# Code interpreter (Python)

The `run_python` tool gives the model a sandboxed Python 3 interpreter
backed by [Pyodide](https://pyodide.org/) running in a Node `worker_threads`
worker. One persistent interpreter per active conversation: variables,
imports, and user-defined functions stay resident across turns, so a
follow-up like _"now plot the residuals"_ just works without re-loading the
dataframe. Workers are reaped after 5 minutes of idle (configurable) and
re-spawn on the next call.

Pre-installed scientific stack: `numpy`, `pandas`, `matplotlib`, `scipy`,
`sympy`, `scikit-learn` (loaded on first use). The standard library is
available except `subprocess`, sockets, threads, and native C extensions
Pyodide doesn't ship. `micropip` is available for pure-Python wheels and
rides the same network gate (see below).

## File round-trip

Files attached to messages in the conversation are materialized into
`/workspace/` before the call — uploads in the composer's accept set (xlsx,
csv, pdf, txt, json, images, ...) become real files the model can
`pd.read_excel(...)`, `open(...)`, etc. Any file the call writes under
`/workspace/` is persisted back as an attachment on the assistant message:
images and videos render inline in the tool block, everything else (`.csv`,
`.xlsx`, `.pdf`, …) shows as a download chip. The next turn re-mounts those
generated files, so the model can build on its own previous outputs.

## Network reach

Pyodide's `pyfetch` and the stdlib `urllib` / `requests` shim all funnel
through one `globalThis.fetch` chokepoint that:

1. Honors the conversation's **Web access** toggle — turning it off in the
   composer popover blocks `pyfetch`, `urllib`, and `micropip.install`
   together, so the model can't end-around the toggle through Python.
2. Refuses private / loopback / link-local / CGNAT / cloud-metadata
   destinations (same SSRF policy as `fetch_url`).
3. Refuses any host configured as an `[[endpoints]]` upstream or as the
   SearxNG instance, so the model can't reach your bridge, upstream LLM, or
   search backend through the interpreter.

## Resource limits

Each call has a wall-clock budget (default 30 s); on overrun the worker is
terminated and the entry transitions to "failed", so the next call re-spawns
fresh (with prior in-memory state gone — documented to the model in the
tool's description). Each worker carries a V8 old-space cap (default
512 MB); a runaway allocation exits cleanly and the model gets a
`memory-cap` error instead of taking the Node process down. A pool cap
(default 10) LRU-evicts the least-recently-used idle interpreter when an
11th conversation lights up.

## Configuration

The `[code_interpreter]` block in `config.toml` is entirely optional — the
defaults below are what ships:

```toml
[code_interpreter]
enabled = true                  # master switch — false hides run_python entirely
pool_max = 10                   # max concurrent live workers (LRU-evicted past this)
idle_timeout_seconds = 300      # 5 min of inactivity → worker reaped
call_timeout_seconds = 30       # wall-clock per call → terminate on overrun
worker_memory_mb = 512          # V8 old-space cap per worker
# pyodide_index_url = ""        # leave empty to resolve from node_modules
```

Memory-wise: each warm interpreter sits at roughly 100–500 MB depending on
which packages got loaded, so the default `pool_max = 10` plus
`worker_memory_mb = 512` worst-cases at ~5 GB resident if every slot is
saturated. Tighten `pool_max` on lower-spec hosts; tighten
`idle_timeout_seconds` to reclaim memory faster between bursts of use.

## Per-conversation gating

`run_python` lives in its own `code_interpreter` feature category — one
switch in the composer's toggles popover. Default is on (when
`enabled = true` at the config level), per the same "all features on by
default" rule the other toggles follow. Custom-model presets can default the
category off via the per-category checkboxes on the model edit page. The
**Web access** toggle independently controls Python's network egress — see
[feature toggles](tools.md#per-conversation-feature-toggles).

## Not supported in v1

Streaming stdout (capture-and-return at end), variable persistence across
worker reaps (lost on idle / timeout / OOM), workspace browse UI, micropip
wheel cache, languages other than Python. See the code-interpreter entry in
[`ROADMAP.md`](../ROADMAP.md) for the phase-2 hook points already wired into
v1's shape.
