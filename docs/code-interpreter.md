# Code interpreter (Python)

The `run_python` tool gives the model a sandboxed Python 3 interpreter
backed by [Pyodide](https://pyodide.org/) running in its own Node child
process. One persistent interpreter per active conversation: variables,
imports, and user-defined functions stay resident across turns, so a
follow-up like _"now plot the residuals"_ just works without re-loading the
dataframe. Workers are reaped after 5 minutes of idle (configurable) and
re-spawn on the next call.

Pre-installed scientific stack: `numpy`, `pandas`, `matplotlib`, `scipy`,
`sympy`, `scikit-learn` (loaded on first use). The first use of a package
downloads it from Pyodide's CDN through the same network policy; the server
then caches the wheel next to the Pyodide package, but only after checking it
against Pyodide's lockfile, so later interpreters start warm. The standard library is
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

## Isolation

Each interpreter is a separate process started under Node's
[permission model](https://nodejs.org/api/permissions.html). It gets no
environment variables, can read only its own code and the Pyodide package,
cannot write files, cannot start processes or threads, and cannot open
network connections. That boundary is enforced by Node, not by the
interpreter, so it holds even for code that reaches past Python into the
JavaScript runtime underneath. Files reach the interpreter only by being
copied into its in-memory `/workspace/` (see below), and come back the same
way.

## Network reach

Because the interpreter can't open connections, Pyodide's `pyfetch` and the
stdlib `urllib` / `requests` shim all funnel through a `fetch` that hands the
request to the server, which applies the policy and makes the request on the
interpreter's behalf:

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
tool's description). Each worker process carries a V8 heap cap (default
512 MB; see the caveat below). A pool cap
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
worker_memory_mb = 512          # V8 heap cap per worker process
python_memory_mb = 1024         # Python's own memory (the WASM heap) per worker
# pyodide_index_url = ""        # leave empty to resolve from node_modules
```

Memory-wise: each warm interpreter sits at roughly 100–500 MB depending on
which packages got loaded, so the default `pool_max = 10` plus
`worker_memory_mb = 512` worst-cases at ~5 GB resident if every slot is
saturated. Tighten `pool_max` on lower-spec hosts; tighten
`idle_timeout_seconds` to reclaim memory faster between bursts of use.

`pool_max` is a global ceiling. A single user is additionally capped at half
of it (minimum 1), so one account running Python in many conversations at
once can't hold every slot and lock everyone else out.

**What bounds Python's memory is `python_memory_mb`** (default 1024), not
`worker_memory_mb`. Pyodide's Python heap is WebAssembly memory, outside the V8
heap that `worker_memory_mb` caps; `python_memory_mb` limits it through V8's own
WebAssembly page limit. An allocation past it fails inside Python with
`MemoryError`, which the script can catch, and the interpreter keeps running.
A warm interpreter with the scientific stack loaded sits around 500 MB, so the
default leaves headroom; raise it for big data work. A process-level limit
(`mem_limit` in docker-compose, `MemoryMax=` under systemd) is still a sensible
backstop for the whole server.

Files attached to a conversation are mounted into `/workspace/` on every call,
capped at 25 MB per file and 50 MB per call. Anything over budget is skipped
with a server-log warning and simply isn't there for the model — which is how
a missing file already behaves.

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
