/**
 * The code-interpreter worker, for real: the esbuild-bundled worker.js running
 * as the restricted child process the pool spawns, with the real `pyodide`
 * package, and its network requests answered by the real host-side proxy.
 *
 * pyodide-pool.test.ts drives a fake worker and run-python-tool.test.ts mocks the
 * pool, so worker.ts would otherwise never run in CI. pyodide is 314.x, so its
 * minors auto-merge; a change to `loadPyodide`, the FS API, PyProxy conversion,
 * or how `pyfetch` reaches `globalThis.fetch` would pass the suite unnoticed.
 *
 * Covers stdout + return value, /workspace files in both directions, the
 * proxy refusing a loopback address, a configured backend host, and any
 * network call when the conversation has web disabled (each against a live
 * local HTTP server that must see zero requests), and the process boundary
 * itself: model code must not see the host environment, read or write host
 * files, start processes, or open sockets of its own.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	pyodideModuleUrl,
	spawnInterpreterProcess,
	type ManagedWorker,
} from '../../src/lib/server/code-interpreter/spawn';
import {
	proxyInterpreterFetch,
	type ProxyFetchRequest,
} from '../../src/lib/server/code-interpreter/net-proxy';

const WORKER_TS = fileURLToPath(
	new URL('../../src/lib/server/code-interpreter/worker.ts', import.meta.url),
);
// Same output path as `pnpm build:worker`.
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

let worker: ManagedWorker;
let http: Server;
let httpHits = 0;
let httpUrl = '';
let nextCallId = 1;
/** The in-flight run's `web` toggle, as the pool tracks it on the entry. */
let webDisabled = false;
const listeners = new Set<(m: WorkerReply) => void>();

function reply(predicate: (m: WorkerReply) => boolean): Promise<WorkerReply> {
	return new Promise((resolve) => {
		const onMessage = (m: WorkerReply) => {
			if (!predicate(m)) return;
			listeners.delete(onMessage);
			resolve(m);
		};
		listeners.add(onMessage);
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
	webDisabled = (opts.disabledFeatures ?? []).includes('web');
	const done = reply((m) => m.type !== 'ready' && m.callId === callId);
	worker.postMessage({ type: 'run', callId, code, preFiles });
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

	// A Python ceiling well under what one test asks for, to prove it holds.
	worker = spawnInterpreterProcess({ workerPath: WORKER_JS, memoryMb: 512, pythonMemoryMb: 384 });
	worker.on('message', (raw) => {
		const m = raw as { type: string; fetchId?: number; request?: ProxyFetchRequest };
		if (m.type === 'fetch') {
			// Mirror the pool: the host owns the policy.
			proxyInterpreterFetch(m.request!, {
				webDisabled,
				forbiddenHosts: new Set(['llm.backend.test']),
			}).then(
				(response) => worker.postMessage({ type: 'fetch-result', fetchId: m.fetchId, response }),
				(err: Error) =>
					worker.postMessage({ type: 'fetch-result', fetchId: m.fetchId, error: err.message }),
			);
			return;
		}
		for (const l of [...listeners]) l(raw as WorkerReply);
	});
	const ready = reply((m) => m.type === 'ready' || (m.type === 'error' && m.callId === -1));
	worker.postMessage({ type: 'init', pyodideModuleUrl: pyodideModuleUrl() });
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

	it('keeps at most a million characters of stdout, and says how much it dropped', async () => {
		const res = (await run('for _ in range(3000):\n    print("y" * 999)')) as { stdout: string };
		expect(res.stdout.length).toBeLessThan(1_000_100);
		expect(res.stdout).toMatch(/\[… \d+ more characters of output not kept\]$/);
	});

	it('raises MemoryError past the Python memory ceiling, and the worker survives', async () => {
		const res = (await run(
			'try:\n    b = bytearray(600 * 1024 * 1024)\n    print("allocated")\nexcept MemoryError:\n    print("MemoryError")',
		)) as { type: string; stdout: string };
		expect(res).toMatchObject({ type: 'result', stdout: 'MemoryError' });
		// Same worker, still usable.
		expect(await run('1 + 1')).toMatchObject({ type: 'result', result: 2 });
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
			// Match the shim's own refusal: Node's fetch rejects file: URLs by itself,
			// so a bare "BLOCKED" would pass with the scheme check removed.
			expect(res.type === 'result' && String(res.result)).toMatch(/Refused scheme "file:"/);
			expect(res.type === 'result' && String(res.result)).not.toMatch(/root:/);
		});
	});
	describe('process boundary', () => {
		const probe = (expr: string) =>
			[
				'import js',
				'try:',
				`    result = "REACHED: " + str(${expr})`,
				'except Exception as e:',
				'    result = "BLOCKED: " + str(e)',
				'result',
			].join('\n');

		it('sees none of the host environment', async () => {
			// macOS injects __CF_USER_TEXT_ENCODING into every process it starts;
			// it carries nothing of the host's.
			const hostKeys = Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING');
			expect(hostKeys.length).toBeGreaterThan(0);
			const res = await run(
				`import js, json\nhost = set(json.loads(${JSON.stringify(JSON.stringify(hostKeys))}))\nsorted(host & set(js.process.env.object_keys()))`,
			);
			expect(res).toMatchObject({ type: 'result', result: [] });
		});

		it.each([
			[
				'reading a host file',
				`js.process.getBuiltinModule("fs").readFileSync("/etc/passwd", "utf8")`,
			],
			[
				'reading the process environment block',
				`js.process.getBuiltinModule("fs").readFileSync("/proc/self/environ", "utf8")`,
			],
			[
				'writing a host file',
				`js.process.getBuiltinModule("fs").writeFileSync("/tmp/glyphstream-pwn", "x")`,
			],
			['starting a process', `js.process.getBuiltinModule("child_process").execSync("id")`],
			['signalling the host', `js.process.kill(js.process.ppid, 0)`],
			['signalling through the raw binding', `js.process._kill(js.process.ppid, 0)`],
		])('refuses %s', async (_name, expr) => {
			const res = await run(probe(expr));
			expect(res.type === 'result' && String(res.result)).toMatch(
				/^BLOCKED: .*(restricted|denied|ENOENT|not permitted)/is,
			);
		});

		it('cannot resolve or reach hosts without the proxy', async () => {
			const res = await run(
				[
					'import js',
					'from pyodide.ffi import JsException',
					'try:',
					`    await js.process.getBuiltinModule("dns").promises.lookup("example.com")`,
					'    result = "REACHED"',
					'except Exception as e:',
					'    result = "BLOCKED: " + str(e)',
					'result',
				].join('\n'),
			);
			expect(res.type === 'result' && String(res.result)).toMatch(/^BLOCKED: .*ACCESS_DENIED/s);
		});
	});
});
