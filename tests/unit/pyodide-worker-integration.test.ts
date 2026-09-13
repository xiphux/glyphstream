/**
 * The code-interpreter worker, for real: the esbuild-bundled worker.js running
 * in a `worker_threads` Worker with the real `pyodide` package.
 *
 * pyodide-pool.test.ts drives a fake worker and run-python-tool.test.ts mocks the
 * pool, so worker.ts never ran in CI. pyodide is 314.x, so its minors
 * auto-merge; a change to `loadPyodide`, the FS API, PyProxy conversion, or how
 * `pyfetch` reaches `globalThis.fetch` would have passed the suite. The last one
 * is a security regression rather than a breakage: the worker's fetch shim is
 * the only thing standing between model-written Python and the host network.
 *
 * Covers stdout + return value, /workspace files in both directions, and the
 * shim refusing a loopback address, a configured backend host, and any network
 * call when the conversation has web disabled — each against a live local HTTP
 * server that must see zero requests.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WORKER_TS = fileURLToPath(
	new URL('../../src/lib/server/code-interpreter/worker.ts', import.meta.url),
);
// Same output path as `pnpm build:worker`, so `import 'pyodide'` (external)
// resolves from the repo's node_modules exactly as it does in dev and prod.
const WORKER_JS = fileURLToPath(
	new URL('../../src/lib/server/code-interpreter/worker.js', import.meta.url),
);

type WorkerReply =
	| { type: 'ready' }
	| {
			type: 'result';
			callId: number;
			stdout: string;
			stderr: string;
			result: unknown;
			newFiles: Array<{ filename: string; bytes: Uint8Array; sha256: string }>;
	  }
	| { type: 'error'; callId: number; message: string };

let worker: Worker;
let http: Server;
let httpHits = 0;
let httpUrl = '';
let nextCallId = 1;

function reply(predicate: (m: WorkerReply) => boolean): Promise<WorkerReply> {
	return new Promise((resolve, reject) => {
		const onMessage = (m: WorkerReply) => {
			if (!predicate(m)) return;
			worker.off('message', onMessage);
			worker.off('error', reject);
			resolve(m);
		};
		worker.on('message', onMessage);
		worker.once('error', reject);
	});
}

async function run(
	code: string,
	opts: { disabledFeatures?: string[]; preFiles?: Array<{ filename: string; text: string }> } = {},
) {
	const callId = nextCallId++;
	const preFiles = (opts.preFiles ?? []).map((f) => {
		const bytes = new TextEncoder().encode(f.text);
		return {
			filename: f.filename,
			bytes,
			sha256: createHash('sha256').update(bytes).digest('hex'),
		};
	});
	const done = reply((m) => m.type !== 'ready' && m.callId === callId);
	worker.postMessage({
		type: 'run',
		callId,
		code,
		disabledFeatures: opts.disabledFeatures ?? [],
		preFiles,
	});
	return done;
}

beforeAll(async () => {
	await build({
		entryPoints: [WORKER_TS],
		bundle: true,
		platform: 'node',
		target: 'node26',
		format: 'esm',
		external: ['pyodide'],
		outfile: WORKER_JS,
		logLevel: 'silent',
	});

	http = createServer((_req, res) => {
		httpHits++;
		res.end('reached the host network');
	});
	await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
	httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;

	worker = new Worker(WORKER_JS);
	const ready = reply((m) => m.type === 'ready' || (m.type === 'error' && m.callId === -1));
	worker.postMessage({ type: 'init', forbiddenHosts: ['LLM.Backend.Test'] });
	const first = await ready;
	if (first.type !== 'ready') throw new Error(`worker init failed: ${JSON.stringify(first)}`);
}, 120_000);

afterAll(async () => {
	await worker?.terminate();
	await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
});

describe('code-interpreter worker (real pyodide)', () => {
	it('captures stdout and converts the return value', async () => {
		const res = await run('print("hello from python")\nsum(range(10))');
		// The worker's batched stdout handler receives each line without its
		// trailing newline — that's the shape run_python reports today.
		expect(res).toMatchObject({ type: 'result', stdout: 'hello from python', result: 45 });
	});

	it('mounts pre-files into /workspace and returns files the code writes', async () => {
		const res = await run(
			[
				'rows = open("/workspace/in.csv").read().strip().splitlines()',
				'open("/workspace/out.txt", "w").write(f"{len(rows)} rows")',
				'len(rows)',
			].join('\n'),
			{ preFiles: [{ filename: 'in.csv', text: 'a,b\n1,2\n3,4\n' }] },
		);
		expect(res.type).toBe('result');
		if (res.type !== 'result') return;
		expect(res.result).toBe(3);
		const out = res.newFiles.find((f) => f.filename === 'out.txt');
		expect(out && new TextDecoder().decode(out.bytes)).toBe('3 rows');
		// The unchanged input is not echoed back as a new file.
		expect(res.newFiles.map((f) => f.filename)).not.toContain('in.csv');
	});

	describe('network shim', () => {
		const tryFetch = (url: string) =>
			[
				'from pyodide.http import pyfetch',
				'try:',
				`    r = await pyfetch(${JSON.stringify(url)})`,
				'    result = "FETCHED: " + await r.string()',
				'except Exception as e:',
				'    result = "BLOCKED: " + str(e)',
				'result',
			].join('\n');

		it('refuses a loopback address', async () => {
			const hitsBefore = httpHits;
			const res = await run(tryFetch(httpUrl));
			expect(res.type).toBe('result');
			if (res.type !== 'result') return;
			expect(String(res.result)).toMatch(/^BLOCKED: .*Refused/s);
			expect(httpHits).toBe(hitsBefore);
		});

		it('refuses a configured backend host (case-insensitively)', async () => {
			const res = await run(tryFetch('http://llm.backend.test/v1/models'));
			expect(res.type === 'result' && String(res.result)).toMatch(/configured backend/);
		});

		it('refuses every network call when web is disabled for the conversation', async () => {
			const res = await run(tryFetch('https://example.com/'), { disabledFeatures: ['web'] });
			expect(res.type === 'result' && String(res.result)).toMatch(/web access is disabled/);
		});

		it('refuses a non-http(s) scheme', async () => {
			const res = await run(tryFetch('file:///etc/passwd'));
			expect(res.type === 'result' && String(res.result)).toMatch(/^BLOCKED: /);
			expect(res.type === 'result' && String(res.result)).not.toMatch(/root:/);
		});
	});
});
