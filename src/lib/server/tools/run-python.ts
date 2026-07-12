/**
 * `run_python` — executes Python in this conversation's persistent
 * Pyodide interpreter. Variables persist across calls within the same
 * worker session; files written under /workspace/ are persisted as
 * conversation attachments (via the existing media store) and the
 * subsequent turn sees them again under their original names.
 *
 * Gating:
 *  - tool registration is conditional on the global config switch
 *    (`isCodeInterpreterEnabled`)
 *  - per-conversation visibility is the existing `code_interpreter`
 *    feature-category filter on the request-build tool list
 *  - Python NETWORK is gated by the conversation's `web` toggle (the
 *    worker's globalThis.fetch shim honors `disabledFeatures.has('web')`)
 *    and by stage 2's url-policy (SSRF + configured-backend block).
 *    micropip rides on the same gate.
 *
 * Approval: none (built-in tool; sandboxed by construction via WASM
 * memory isolation + per-worker memory cap + wall-clock timeout +
 * the network shim above).
 */

import { register } from './registry';
import type { Tool, ToolExecution } from './types';
import { getCodeInterpreterConfig, isCodeInterpreterEnabled } from '../code-interpreter/config';
import { runPython } from '../code-interpreter/pool';
import { collectConversationFiles, persistGeneratedFiles } from '../code-interpreter/files';
import type { RunPythonPreFile } from '../code-interpreter/pool';

// Memoized at module scope: building the description requires reading
// `config.toml`, and SvelteKit's analyse postbuild loads every server
// module during `vite build` — including this one — when config.toml is
// not yet in the docker build context (it's runtime-only). Computing
// the description eagerly in the tool-literal-init would throw at build
// time; gating it behind a getter that fires on first read keeps the
// build clean and shifts validation to first request (which is fine —
// every other config validator in this codebase is similarly lazy, and
// production deployments always have config.toml present by then).
let cachedDescription: string | null = null;
function getRunPythonDescription(): string {
	if (cachedDescription !== null) return cachedDescription;
	cachedDescription = buildToolDescription();
	return cachedDescription;
}

/**
 * The registry's largest description by some margin, and it ships on every single
 * request whenever the code interpreter is enabled — including in the many
 * conversations that never run a line of Python. Every sentence here is rent, so
 * it states only what the model cannot discover from a single error message:
 * what's preinstalled, that state persists, where the files are, and that network
 * may simply not be there. The failure modes (timeout, OOM) announce themselves.
 */
function buildToolDescription(): string {
	const cfg = getCodeInterpreterConfig();
	return `Execute Python in this conversation's persistent sandboxed interpreter (CPython 3 via Pyodide).

Preinstalled: numpy, pandas, matplotlib, scipy, sympy, scikit-learn. Standard library minus subprocess/sockets/threading and any native C extension Pyodide doesn't ship. micropip installs more, but needs network.

State: variables, imports, and definitions persist across calls in this conversation. They're lost if the interpreter restarts — after a timed-out call, an out-of-memory call, or ${Math.round(cfg.idleTimeoutSeconds / 60)} minutes idle.

Files: this conversation's attachments are mounted under /workspace/. Write there to hand a file back to the user (images and videos render inline, everything else as a download chip); files written elsewhere vanish with the session.

Network: may be disabled by conversation settings, and is egress-filtered when on. Do NOT assume it works — handle the failure.

Limits: ${cfg.callTimeoutSeconds}s per call, ~${cfg.workerMemoryMb} MB memory. Exceeding either kills the interpreter and loses state, so chunk heavy work.

Output: stdout, stderr, and the last expression's value come back. Print selectively — a full repr of a large frame floods the response.`;
}

export const runPythonTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'run_python',
			get description(): string {
				return getRunPythonDescription();
			},
			parameters: {
				type: 'object',
				properties: {
					code: {
						type: 'string',
						description: "Python source to execute in this conversation's persistent interpreter.",
					},
				},
				required: ['code'],
				additionalProperties: false,
			},
		},
	},
	metadata: {
		displayLabel: 'Python',
		icon: 'terminal',
		category: 'code_interpreter',
	},
	isAvailable: () => isCodeInterpreterEnabled(),
	/**
	 * Lazy getter: reads the configured call timeout at execution time and
	 * adds a margin to cover overhead that the inner pool timer doesn't
	 * include — Pyodide cold start (~2-5s), file materialization (~1-2s),
	 * and pool mutex queueing (headroom for serialized parallel calls).
	 *
	 * Must be lazy (same rationale as `description`): the tool object is
	 * evaluated at module-import time during SvelteKit's analyse postbuild
	 * (docker build context doesn't have config.toml), so an eager read
	 * would throw.
	 *
	 * The outer wall-clock timeout (this value) is strictly longer than
	 * the pool's own per-call budget (`callTimeoutSeconds`) so that
	 * `executeToolCalls` in tool-execution.ts does not abort while the
	 * call is still waiting in the pool mutex queue or during cold start.
	 * The pool's internal timer (started after `ensureReady` + mutex
	 * acquire) is the precise budget the model sees described; this outer
	 * signal exists only to prevent stuck goroutines from hanging the
	 * tool-call slot indefinitely.
	 *
	 * Note: mutex queueing under heavy parallel `run_python` calls in one
	 * conversation is unbounded and can't be fully covered by a static
	 * margin. Multi-second queue waits are normal; if the queue exceeds
	 * the margin the outer timer will fire and produce a false-positive
	 * timeout. A future enhancement could track queue depth and adjust
	 * the margin dynamically, but for the self-hosted scale this targets,
	 * a 30s static margin suffices.
	 */
	get timeoutMs(): number {
		return getCodeInterpreterConfig().callTimeoutSeconds * 1000 + 30_000;
	},
	async execute(args, ctx): Promise<ToolExecution> {
		if (!args || typeof args !== 'object' || typeof (args as { code: unknown }).code !== 'string') {
			return {
				content: JSON.stringify({ error: 'Missing or invalid `code` argument (string).' }),
				isError: true,
			};
		}
		const code = (args as { code: string }).code;
		if (code.length === 0) {
			return {
				content: JSON.stringify({ error: '`code` must be a non-empty string.' }),
				isError: true,
			};
		}

		let preFiles: RunPythonPreFile[];
		try {
			preFiles = await collectConversationFiles(ctx.conversationId, ctx.userId);
		} catch (e) {
			// Collecting files shouldn't be fatal — execute with an empty
			// workspace so the model can still run pure-compute code and
			// log the collection failure in stderr-shape so the model
			// knows files might be missing.
			preFiles = [];
			console.warn('[run_python] collectConversationFiles failed:', e);
		}

		try {
			const result = await runPython({
				conversationId: ctx.conversationId,
				code,
				disabledFeatures: ctx.disabledFeatures,
				preFiles,
				ctxSignal: ctx.signal,
			});

			let attachedMediaIds: string[] | undefined;
			if (result.newFiles.length > 0) {
				try {
					attachedMediaIds = await persistGeneratedFiles({
						userId: ctx.userId,
						files: result.newFiles,
					});
				} catch (e) {
					// Persistence failure shouldn't lose the call's other
					// output — surface the filenames in stderr-ish form so
					// the model knows the files were produced but couldn't
					// be saved, and the user can re-ask.
					console.warn('[run_python] persistGeneratedFiles failed:', e);
				}
			}

			const payload: Record<string, unknown> = {
				stdout: result.stdout,
				stderr: result.stderr,
				value: result.result,
			};
			if (attachedMediaIds && attachedMediaIds.length > 0) {
				payload.files = attachedMediaIds.map((id, i) => ({
					media_id: id,
					filename: result.newFiles[i].filename,
				}));
			}

			return {
				content: JSON.stringify(payload),
				...(attachedMediaIds && attachedMediaIds.length > 0 ? { attachedMediaIds } : {}),
			};
		} catch (e) {
			return {
				content: JSON.stringify({
					error: e instanceof Error ? e.message : String(e),
				}),
				isError: true,
			};
		}
	},
};

register(runPythonTool);
