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
	config: {
		enabled: true,
		poolMax: 10,
		idleTimeoutSeconds: 300,
		callTimeoutSeconds: 30,
		workerMemoryMb: 512,
		pyodideIndexUrl: '',
	},
}));

vi.mock('$lib/server/code-interpreter/config', () => ({
	getCodeInterpreterConfig: () => mocks.config,
	isCodeInterpreterEnabled: () => mocks.enabled,
	resetCodeInterpreterConfigForTests: () => {},
}));

vi.mock('$lib/server/code-interpreter/pool', () => ({
	runPython: (...args: unknown[]) => mocks.runPython(...args),
}));

vi.mock('$lib/server/code-interpreter/files', () => ({
	collectConversationFiles: (...args: unknown[]) => mocks.collectConversationFiles(...args),
	persistGeneratedFiles: (...args: unknown[]) => mocks.persistGeneratedFiles(...args),
}));

import { runPythonTool } from '$lib/server/tools/run-python';
import type { ToolContext } from '$lib/server/tools/types';

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
	// Sensible defaults: empty pre-file list, basic success result.
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
		const desc = runPythonTool.definition.function.description;
		expect(desc).toContain('30-second wall-clock');
		expect(desc).toContain('512 MB of memory');
		expect(desc).toContain(`${Math.round(mocks.config.idleTimeoutSeconds / 60)} minutes`);
	});

	it('timeoutMs reflects callTimeoutSeconds + margin, read lazily per config', () => {
		// The getter reads getCodeInterpreterConfig() at access time, so
		// changing mocks.config.callTimeoutSeconds between reads produces
		// different values — verify a few points across the valid range.
		const expectations: { callTimeoutSeconds: number; expected: number }[] = [
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
		const parsed = JSON.parse(r.content);
		expect(parsed.files).toEqual([
			{ media_id: 'media-1', filename: 'out.png' },
			{ media_id: 'media-2', filename: 'out.csv' },
		]);
	});

	it('omits attachedMediaIds when no files were generated', async () => {
		const r = await runPythonTool.execute({ code: 'print(1)' }, ctx());
		expect(r.attachedMediaIds).toBeUndefined();
		const parsed = JSON.parse(r.content);
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
