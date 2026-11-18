/**
 * `cache-package` is the one message an interpreter sends the host that no
 * call asked for, and its bytes are already buffered in the server by the
 * time the pool sees them. Only a run importing a package has a reason to
 * send one, so anything else stops the interpreter before it sends another.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ cached: [] as Array<{ path: string; size: number }> }));
vi.mock('../../src/lib/server/code-interpreter/package-cache', () => ({
	cachePyodideWheel: (path: string, bytes: Uint8Array) => {
		seen.cached.push({ path, size: bytes.byteLength });
		return Promise.resolve(false);
	},
}));
vi.mock('../../src/lib/server/code-interpreter/config', () => {
	const cfg = {
		enabled: true,
		poolMax: 3,
		idleTimeoutSeconds: 300,
		callTimeoutSeconds: 30,
		workerMemoryMb: 512,
		pythonMemoryMb: 1024,
		pyodideIndexUrl: '',
	};
	return { getCodeInterpreterConfig: () => cfg, isCodeInterpreterEnabled: () => true };
});

import {
	type ManagedWorker,
	resetCodeInterpreterPoolForTests,
	runPython,
	setWorkerFactoryForTests,
} from '../../src/lib/server/code-interpreter/pool';

/** Answers `init` and `run`; `duringRun` is posted before a run's result. */
class FakeWorker extends EventEmitter implements ManagedWorker {
	terminated = false;
	duringRun: unknown[] = [];
	postMessage(value: unknown): void {
		const msg = value as { type: string; callId?: number };
		if (msg.type === 'init') queueMicrotask(() => this.emit('message', { type: 'ready' }));
		else if (msg.type === 'run') {
			queueMicrotask(() => {
				for (const m of this.duringRun) this.emit('message', m);
				if (this.terminated) return;
				this.emit('message', {
					type: 'result',
					callId: msg.callId,
					stdout: '',
					stderr: '',
					result: 1,
				});
			});
		}
	}
	terminate(): Promise<number> {
		if (!this.terminated) {
			this.terminated = true;
			this.emit('exit', 137);
		}
		return Promise.resolve(137);
	}
}

function wheel(size: number) {
	return {
		type: 'cache-package',
		path: '/pkg/numpy-2.0-cp313-pyodide.whl',
		bytes: new Uint8Array(size),
	};
}

afterEach(async () => {
	seen.cached = [];
	await resetCodeInterpreterPoolForTests();
	setWorkerFactoryForTests(null);
});

function spawnOne(): () => FakeWorker {
	let worker: FakeWorker | undefined;
	setWorkerFactoryForTests(() => (worker = new FakeWorker()));
	return () => worker!;
}

const run = () =>
	runPython({ conversationId: 'c1', userId: 'u1', code: 'import numpy', disabledFeatures: [] });

describe('host side of cache-package', () => {
	it('caches a wheel sent while a run is importing it', async () => {
		setWorkerFactoryForTests(() => {
			const w = new FakeWorker();
			w.duringRun = [wheel(1024)];
			return w;
		});
		await run();
		expect(seen.cached).toEqual([{ path: '/pkg/numpy-2.0-cp313-pyodide.whl', size: 1024 }]);
	});

	it('kills an interpreter that sends one with no run in flight, without caching it', async () => {
		const worker = spawnOne();
		await run();
		worker().emit('message', wheel(1024));
		expect(seen.cached).toEqual([]);
		expect(worker().terminated).toBe(true);
	});

	it('kills an interpreter that sends an oversized one during a run', async () => {
		let w!: FakeWorker;
		setWorkerFactoryForTests(() => {
			w = new FakeWorker();
			w.duringRun = [wheel(65 * 1024 * 1024)];
			return w;
		});
		await expect(run()).rejects.toThrow(/exited/);
		expect(seen.cached).toEqual([]);
		expect(w.terminated).toBe(true);
	});

	it('kills an interpreter that sends a malformed one', async () => {
		let w!: FakeWorker;
		setWorkerFactoryForTests(() => {
			w = new FakeWorker();
			w.duringRun = [{ type: 'cache-package', path: 'x.whl', bytes: 'not bytes' }];
			return w;
		});
		await expect(run()).rejects.toThrow(/exited/);
		expect(seen.cached).toEqual([]);
		expect(w.terminated).toBe(true);
	});

	it('starts a fresh interpreter on the next run after a kill', async () => {
		const worker = spawnOne();
		await run();
		const first = worker();
		first.emit('message', wheel(1024));
		await run();
		expect(worker()).not.toBe(first);
	});
});
