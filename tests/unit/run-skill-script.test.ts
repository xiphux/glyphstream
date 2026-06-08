/**
 * Unit tests for the `run_skill_script` tool — runs a skill's bundled Python in
 * the code-interpreter sandbox. Pool / files / config / skills-db are mocked and
 * the skill store is a fake; the real materialization helper runs against the
 * fake store (so the entry+siblings → preFiles path is exercised end to end).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	enabled: true,
	runPython: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
	collectConversationFiles: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
	persistGeneratedFiles: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
	getEnabledSkillByName: vi.fn<(...a: unknown[]) => unknown>(),
	bundle: {} as Record<string, string>,
}));

vi.mock('$lib/server/code-interpreter/config', () => ({
	getCodeInterpreterConfig: () => ({}),
	isCodeInterpreterEnabled: () => mocks.enabled,
	resetCodeInterpreterConfigForTests: () => {},
}));
vi.mock('$lib/server/code-interpreter/pool', () => ({
	runPython: (...a: unknown[]) => mocks.runPython(...a),
}));
vi.mock('$lib/server/code-interpreter/files', () => ({
	collectConversationFiles: (...a: unknown[]) => mocks.collectConversationFiles(...a),
	persistGeneratedFiles: (...a: unknown[]) => mocks.persistGeneratedFiles(...a),
}));
vi.mock('$lib/server/db/queries/skills', () => ({
	getEnabledSkillByName: (...a: unknown[]) => mocks.getEnabledSkillByName(...a),
}));
vi.mock('$lib/server/skills/disk-store', () => ({
	getSkillStore: () => ({
		listFiles: async () => Object.keys(mocks.bundle),
		readFile: async (_sp: string, rel: string) =>
			rel in mocks.bundle ? { bytes: Buffer.from(mocks.bundle[rel], 'utf8'), relPath: rel } : null,
	}),
}));

import { runSkillScriptTool } from '$lib/server/tools/activate-skill';
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

async function run(args: unknown, c: ToolContext = ctx()) {
	const r = await runSkillScriptTool.execute(args, c);
	return { ...r, parsed: JSON.parse(r.content) as Record<string, unknown> };
}

beforeEach(() => {
	mocks.enabled = true;
	mocks.runPython.mockReset();
	mocks.collectConversationFiles.mockReset();
	mocks.persistGeneratedFiles.mockReset();
	mocks.getEnabledSkillByName.mockReset();
	mocks.bundle = {
		'SKILL.md': '---\nname: review\n---',
		'scripts/extract.py': 'import helpers\nprint(helpers.go())',
		'scripts/helpers.py': 'def go(): return "skill"',
	};
	mocks.getEnabledSkillByName.mockReturnValue({
		id: 's1',
		name: 'review',
		description: 'd',
		storagePath: 'u1/review',
	});
	mocks.collectConversationFiles.mockResolvedValue([]);
	mocks.runPython.mockResolvedValue({ stdout: 'skill\n', stderr: '', result: null, newFiles: [] });
	mocks.persistGeneratedFiles.mockResolvedValue([]);
});

describe('run_skill_script — metadata', () => {
	it('is a skills-category tool that is never statically advertised', () => {
		expect(runSkillScriptTool.definition.function.name).toBe('run_skill_script');
		expect(runSkillScriptTool.metadata?.category).toBe('skills');
		expect(runSkillScriptTool.isAvailable?.()).toBe(false);
	});
});

describe('run_skill_script — gating', () => {
	it('refuses when skills are disabled for the conversation', async () => {
		const r = await run(
			{ name: 'review', path: 'scripts/extract.py' },
			ctx({ disabledFeatures: ['skills'] }),
		);
		expect(r.isError).toBe(true);
		expect(mocks.runPython).not.toHaveBeenCalled();
	});

	it('refuses when the code interpreter is disabled for the conversation', async () => {
		const r = await run(
			{ name: 'review', path: 'scripts/extract.py' },
			ctx({ disabledFeatures: ['code_interpreter'] }),
		);
		expect(r.isError).toBe(true);
		expect(mocks.runPython).not.toHaveBeenCalled();
	});

	it('refuses when the interpreter is not enabled server-wide', async () => {
		mocks.enabled = false;
		const r = await run({ name: 'review', path: 'scripts/extract.py' });
		expect(r.isError).toBe(true);
		expect(mocks.runPython).not.toHaveBeenCalled();
	});
});

describe('run_skill_script — validation', () => {
	it('rejects a missing path', async () => {
		expect((await run({ name: 'review' })).isError).toBe(true);
	});
	it('rejects a non-.py path', async () => {
		const r = await run({ name: 'review', path: 'references/api.md' });
		expect(r.isError).toBe(true);
		expect(String(r.parsed.error)).toContain('.py');
	});
	it('rejects a non-string args element', async () => {
		const r = await run({ name: 'review', path: 'scripts/extract.py', args: [1] });
		expect(r.isError).toBe(true);
	});
	it('errors on an unknown skill', async () => {
		mocks.getEnabledSkillByName.mockReturnValue(null);
		const r = await run({ name: 'ghost', path: 'scripts/x.py' });
		expect(r.isError).toBe(true);
	});
	it('errors when the entry script is absent from the bundle', async () => {
		const r = await run({ name: 'review', path: 'scripts/missing.py' });
		expect(r.isError).toBe(true);
		expect(mocks.runPython).not.toHaveBeenCalled();
	});
});

describe('run_skill_script — execution', () => {
	it('runs the entry via the bootstrap with flattened sibling pre-files', async () => {
		await run({ name: 'review', path: 'scripts/extract.py', args: ['--x'] });
		expect(mocks.runPython).toHaveBeenCalledTimes(1);
		const call = mocks.runPython.mock.calls[0][0] as {
			code: string;
			preFiles: { filename: string }[];
			conversationId: string;
			ctxSignal: AbortSignal;
		};
		expect(call.code).toContain('runpy.run_path');
		expect(call.code).toContain("run_name='__main__'");
		const names = call.preFiles.map((f) => f.filename).sort();
		expect(names).toEqual(['extract.py', 'helpers.py']);
		expect(call.conversationId).toBe('c1');
		expect(call.ctxSignal).toBeInstanceOf(AbortSignal);
	});

	it('skill files win over conversation files on a basename collision', async () => {
		mocks.collectConversationFiles.mockResolvedValue([
			{ filename: 'helpers.py', bytes: new Uint8Array([1, 2, 3]), sha256: 'conv' },
		]);
		await run({ name: 'review', path: 'scripts/extract.py' });
		const call = mocks.runPython.mock.calls[0][0] as {
			preFiles: { filename: string; bytes: Uint8Array }[];
		};
		const helpers = call.preFiles.find((f) => f.filename === 'helpers.py')!;
		expect(Buffer.from(helpers.bytes).toString('utf8')).toBe('def go(): return "skill"');
	});

	it('returns stdout/stderr and attaches generated files', async () => {
		mocks.runPython.mockResolvedValue({
			stdout: 'out',
			stderr: '',
			result: null,
			newFiles: [{ filename: 'chart.png', bytes: new Uint8Array(), sha256: 'h' }],
		});
		mocks.persistGeneratedFiles.mockResolvedValue(['media-1']);
		const r = await run({ name: 'review', path: 'scripts/extract.py' });
		expect(r.isError).toBeUndefined();
		expect(r.parsed.stdout).toBe('out');
		expect(r.attachedMediaIds).toEqual(['media-1']);
	});

	it('surfaces a worker error as a recoverable result', async () => {
		mocks.runPython.mockRejectedValue(new Error('interpreter restarted'));
		const r = await run({ name: 'review', path: 'scripts/extract.py' });
		expect(r.isError).toBe(true);
		expect(String(r.parsed.error)).toContain('interpreter restarted');
	});
});
