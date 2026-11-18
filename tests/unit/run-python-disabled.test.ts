/**
 * `[code_interpreter] enabled = false` is the operator's hard off. Removing
 * `run_python` from the advertised tools[] is not enough on its own: a tool
 * call is resolved by name, and a prompt-injected model or a lenient-parser
 * upstream can name a function it was never offered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	runPython: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('#lib/server/code-interpreter/config.js', () => ({
	getCodeInterpreterConfig: () => ({
		enabled: false,
		poolMax: 10,
		idleTimeoutSeconds: 300,
		callTimeoutSeconds: 30,
		workerMemoryMb: 512,
		pythonMemoryMb: 1024,
		pyodideIndexUrl: '',
	}),
	isCodeInterpreterEnabled: () => false,
}));

vi.mock('#lib/server/code-interpreter/pool.js', () => ({
	runPython: (...args: unknown[]) => mocks.runPython(...args),
	reserveInterpreterTurn: () => ({ ready: Promise.resolve(), release: () => {} }),
}));

vi.mock('#lib/server/code-interpreter/files.js', () => ({
	collectConversationFiles: () => Promise.resolve([]),
	persistGeneratedFiles: () => Promise.resolve([]),
}));

import '#lib/server/tools/run-python.js';
import { openaiToolDefinitions } from '#lib/server/tools/registry.js';
import { executeOneToolCall } from '#lib/server/streaming/tool-execution.js';

describe('run_python with the code interpreter disabled by the operator', () => {
	beforeEach(() => {
		mocks.runPython.mockReset();
		mocks.runPython.mockResolvedValue({ stdout: 'ran', stderr: '', result: null, newFiles: [] });
	});

	it('is not advertised', () => {
		expect(openaiToolDefinitions().map((d) => d.function.name)).not.toContain('run_python');
	});

	it('is refused when the model calls it anyway', async () => {
		const { execution } = await executeOneToolCall(
			{
				type: 'tool_call',
				toolCallId: 'call_1',
				toolName: 'run_python',
				arguments: JSON.stringify({ code: 'print(1)' }),
			},
			'user-1',
			'conv-1',
			new AbortController().signal,
			[],
		);
		expect(mocks.runPython).not.toHaveBeenCalled();
		expect(execution.isError).toBe(true);
	});
});
