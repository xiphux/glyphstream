/**
 * Unit tests for the `run_python` built-in tool.
 *
 * The tool composes three modules — config / pool / files — that each
 * have their own test files. Here we exercise the integration: arg
 * validation, the `isAvailable` predicate honoring the global enable
 * flag, the disabledFeatures hand-off, the file round-trip orchestration,
 * and the error-shape contract on persistence failure.
 *
 * Pool + files modules are mocked so the test doesn't boot real Pyodide
 * or touch the disk-backed media store. The integration test for the
 * full Pyodide-WASM happy path lives in the smoke verification list, not
 * the unit pass.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	enabled: true,
	runPython: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	collectConversationFiles: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	persistGeneratedFiles: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	reserveInterpreterTurn: vi.fn(),
	/** Every pool interaction, in order: reserve, run, release. */
	poolEvents: [] as string[],
	config: {
		enabled: true,
		poolMax: 10,
		idleTimeoutSeconds: 300,
		callTimeoutSeconds: 30,
		workerMemoryMb: 512,
		pyodideIndexUrl: '',
	},
}));

vi.mock('#lib/server/code-interpreter/config.js', () => ({
	getCodeInterpreterConfig: () => mocks.config,
	isCodeInterpreterEnabled: () => mocks.enabled,
}));

vi.mock('#lib/server/code-interpreter/pool.js', () => ({
	runPython: (...args: unknown[]) => {
		mocks.poolEvents.push('run');
		return mocks.runPython(...args);
	},
	reserveInterpreterTurn: (conversationId: string) => {
		mocks.poolEvents.push('reserve');
		mocks.reserveInterpreterTurn(conversationId);
		return { ready: Promise.resolve(), release: () => mocks.poolEvents.push('release') };
	},
}));

vi.mock('#lib/server/code-interpreter/files.js', () => ({
	collectConversationFiles: (...args: unknown[]) => mocks.collectConversationFiles(...args),
	persistGeneratedFiles: (...args: unknown[]) => mocks.persistGeneratedFiles(...args),
}));

import { runPythonTool } from '#lib/server/tools/run-python.js';
import type { ToolContext } from '#lib/server/tools/types.js';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		userId: 'u1',
		conversationId: 'c1',
		signal: new AbortController().signal,
		disabledFeatures: [],
		...overrides,
	};
}

beforeEach(() => {
	mocks.enabled = true;
	mocks.runPython.mockReset();
	mocks.collectConversationFiles.mockReset();
	mocks.persistGeneratedFiles.mockReset();
	mocks.reserveInterpreterTurn.mockReset();
	mocks.poolEvents = [];
	mocks.collectConversationFiles.mockResolvedValue([]);
	mocks.runPython.mockResolvedValue({
		stdout: 'hello\n',
		stderr: '',
		result: 42,
		newFiles: [],
	});
	mocks.persistGeneratedFiles.mockResolvedValue([]);
});

describe('runPythonTool — metadata + availability', () => {
	it('registers under name "run_python" with category "code_interpreter"', () => {
		expect(runPythonTool.definition.function.name).toBe('run_python');
		expect(runPythonTool.metadata?.category).toBe('code_interpreter');
		expect(runPythonTool.metadata?.displayLabel).toBe('Python');
	});

	it('isAvailable reflects the global config flag', () => {
		mocks.enabled = true;
		expect(runPythonTool.isAvailable?.()).toBe(true);
		mocks.enabled = false;
		expect(runPythonTool.isAvailable?.()).toBe(false);
	});

	it('renders the description lazily, interpolating the active config', () => {
		// The description is computed by a getter — eager evaluation
		// would read config.toml at module-init time and break
		// SvelteKit's analyse postbuild in environments where config.toml
		// hasn't been mounted yet (docker build context, CI).
		//
		// Asserts that the LIMITS come from config, not that any particular
		// sentence surrounds them: the prose is under a size budget (see
		// tool-definition-budget.test.ts) and gets reworded, but a hardcoded
		// timeout that silently disagrees with config.toml would mislead the model.
		const desc = runPythonTool.definition.function.description;
		expect(desc).toContain(`${mocks.config.callTimeoutSeconds}s per call`);
		expect(desc).toContain(`${mocks.config.workerMemoryMb} MB`);
		expect(desc).toContain(`${Math.round(mocks.config.idleTimeoutSeconds / 60)} minutes`);
	});

	it('timeoutMs reflects callTimeoutSeconds + margin, read lazily per config', () => {
		// The getter reads getCodeInterpreterConfig() at access time, so
		// changing mocks.config.callTimeoutSeconds between reads produces
		// different values — verify a few points across the valid range.
		const expectations: Array<{ callTimeoutSeconds: number; expected: number }> = [
			{ callTimeoutSeconds: 30, expected: 30 * 1000 + 30_000 },
			{ callTimeoutSeconds: 120, expected: 120 * 1000 + 30_000 },
			{ callTimeoutSeconds: 300, expected: 300 * 1000 + 30_000 },
			{ callTimeoutSeconds: 600, expected: 600 * 1000 + 30_000 },
		];
		for (const { callTimeoutSeconds, expected } of expectations) {
			mocks.config.callTimeoutSeconds = callTimeoutSeconds;
			expect(runPythonTool.timeoutMs).toBe(expected);
		}
	});

	it('declares { code: string } required, no extra properties', () => {
		const params = runPythonTool.definition.function.parameters as {
			properties: Record<string, unknown>;
			required: string[];
			additionalProperties: boolean;
		};
		expect(params.properties).toHaveProperty('code');
		expect(params.required).toEqual(['code']);
		expect(params.additionalProperties).toBe(false);
	});
});

describe('runPythonTool — arg validation', () => {
	it('rejects missing args entirely', async () => {
		const r = await runPythonTool.execute(undefined, ctx());
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/Missing or invalid `code`/);
	});

	it('rejects non-string code', async () => {
		const r = await runPythonTool.execute({ code: 42 }, ctx());
		expect(r.isError).toBe(true);
	});

	it('rejects empty string code', async () => {
		const r = await runPythonTool.execute({ code: '' }, ctx());
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/non-empty string/);
	});
});

describe('runPythonTool — disabledFeatures pass-through', () => {
	it('forwards ctx.disabledFeatures verbatim into runPython', async () => {
		await runPythonTool.execute(
			{ code: 'print(1)' },
			ctx({ disabledFeatures: ['web', 'personalization'] as const }),
		);
		const call = mocks.runPython.mock.calls[0][0] as {
			disabledFeatures: readonly string[];
		};
		expect(call.disabledFeatures).toEqual(['web', 'personalization']);
	});

	it('forwards an empty array when nothing is disabled', async () => {
		await runPythonTool.execute({ code: 'print(1)' }, ctx());
		const call = mocks.runPython.mock.calls[0][0] as {
			disabledFeatures: readonly string[];
		};
		expect(call.disabledFeatures).toEqual([]);
	});
});

describe('runPythonTool — file round-trip', () => {
	it('passes collected preFiles to runPython', async () => {
		const preFiles = [{ filename: 'data.csv', bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' }];
		mocks.collectConversationFiles.mockResolvedValue(preFiles);
		await runPythonTool.execute({ code: 'open("data.csv")' }, ctx());
		const call = mocks.runPython.mock.calls[0][0] as { preFiles: unknown[] };
		expect(call.preFiles).toEqual(preFiles);
	});

	it('persists newly-written files and returns attachedMediaIds', async () => {
		mocks.runPython.mockResolvedValue({
			stdout: '',
			stderr: '',
			result: null,
			newFiles: [
				{ filename: 'out.png', bytes: new Uint8Array([0]), sha256: 'a' },
				{ filename: 'out.csv', bytes: new Uint8Array([1]), sha256: 'b' },
			],
		});
		mocks.persistGeneratedFiles.mockResolvedValue(['media-1', 'media-2']);

		const r = await runPythonTool.execute({ code: 'save()' }, ctx());
		expect(r.attachedMediaIds).toEqual(['media-1', 'media-2']);
		// The content payload also exposes the file list so the model
		// can reference the files by name in its follow-up.
		const parsed = JSON.parse(r.content) as { files?: unknown };
		expect(parsed.files).toEqual([
			{ media_id: 'media-1', filename: 'out.png' },
			{ media_id: 'media-2', filename: 'out.csv' },
		]);
	});

	it('omits attachedMediaIds when no files were generated', async () => {
		const r = await runPythonTool.execute({ code: 'print(1)' }, ctx());
		expect(r.attachedMediaIds).toBeUndefined();
		const parsed = JSON.parse(r.content) as { files?: unknown };
		expect(parsed.files).toBeUndefined();
	});

	it('survives a file-collection failure — runs with an empty workspace', async () => {
		// The model can still do pure compute even when the conversation
		// has files that can't be materialized; surface no file but let
		// the call succeed.
		mocks.collectConversationFiles.mockRejectedValue(new Error('disk read failed'));
		const r = await runPythonTool.execute({ code: '1+1' }, ctx());
		expect(r.isError).toBeUndefined();
		const call = mocks.runPython.mock.calls[0][0] as { preFiles: unknown[] };
		expect(call.preFiles).toEqual([]);
	});

	it('names unsaved files in stderr when persisting them fails', async () => {
		// Otherwise the model believes its files were saved and tells the user
		// they're attached.
		mocks.runPython.mockResolvedValue({
			stdout: '',
			stderr: 'UserWarning: x',
			result: null,
			newFiles: [
				{ filename: 'out.png', bytes: new Uint8Array([0]), sha256: 'a' },
				{ filename: 'out.csv', bytes: new Uint8Array([1]), sha256: 'b' },
			],
		});
		mocks.persistGeneratedFiles.mockRejectedValue(new Error('media store down'));
		const r = await runPythonTool.execute({ code: 'save()' }, ctx());
		expect(r.isError).toBeUndefined();
		expect(r.attachedMediaIds).toBeUndefined();
		const parsed = JSON.parse(r.content) as { stderr: string; files?: unknown };
		expect(parsed.files).toBeUndefined();
		expect(parsed.stderr).toBe(
			'UserWarning: x\n[could not save out.png, out.csv; these files are NOT attached]',
		);
	});

	it('returns the worker failure as isError when runPython rejects', async () => {
		mocks.runPython.mockRejectedValue(new Error('run_python: exceeded 30s wall-clock budget'));
		const r = await runPythonTool.execute({ code: 'while True: pass' }, ctx());
		expect(r.isError).toBe(true);
		expect(r.content).toMatch(/wall-clock budget/);
	});
});

describe('runPythonTool — abort signal hand-off', () => {
	it('forwards ctx.signal into runPython', async () => {
		const ac = new AbortController();
		await runPythonTool.execute({ code: 'print(1)' }, ctx({ signal: ac.signal }));
		const call = mocks.runPython.mock.calls[0][0] as { ctxSignal: AbortSignal };
		expect(call.ctxSignal).toBe(ac.signal);
	});
});

describe('runPythonTool — interpreter turn', () => {
	it('reserves its turn before its first await and hands it to runPython', async () => {
		// A turn's tool calls are started in tool-call order; reserving before
		// collectConversationFiles is what keeps them in that order.
		let resolveCollect!: (files: unknown[]) => void;
		mocks.collectConversationFiles.mockReturnValue(
			new Promise((resolve) => {
				resolveCollect = resolve;
			}),
		);
		const pending = runPythonTool.execute({ code: 'print(1)' }, ctx());
		expect(mocks.reserveInterpreterTurn).toHaveBeenCalledWith('c1');
		resolveCollect([]);
		await pending;
		expect(mocks.poolEvents).toEqual(['reserve', 'run', 'release']);
		const call = mocks.runPython.mock.calls[0][0] as { turn?: unknown };
		expect(call.turn).toBeDefined();
	});

	it('releases its turn when runPython rejects', async () => {
		mocks.runPython.mockRejectedValue(new Error('boom'));
		await runPythonTool.execute({ code: 'x' }, ctx());
		expect(mocks.poolEvents).toEqual(['reserve', 'run', 'release']);
	});
});
