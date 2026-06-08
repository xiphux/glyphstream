/**
 * Direct execute() tests for the activate_skill + read_skill_file tools.
 *
 * The per-request definitions live in activate-skill-defs.test.ts and the
 * synthesize flow covers activate_skill's happy path indirectly — this pins the
 * execute branches that nothing else asserts: the skills-disabled gate, unknown
 * skills, the "row exists but no SKILL.md on disk" corruption case, the resource
 * manifest, and (for read_skill_file, otherwise untested) the path-jail throw →
 * recoverable isError translation and the <skill_file> wrapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getEnabledSkillByName: vi.fn<(...a: unknown[]) => unknown>(),
	store: {
		readSkillMd: vi.fn<(...a: unknown[]) => Promise<string | null>>(),
		readFile: vi.fn<(...a: unknown[]) => Promise<{ bytes: Buffer; relPath: string } | null>>(),
		listFiles: vi.fn<(...a: unknown[]) => Promise<string[]>>(),
	},
}));

vi.mock('$lib/server/code-interpreter/config', () => ({
	getCodeInterpreterConfig: () => ({}),
	isCodeInterpreterEnabled: () => true,
	resetCodeInterpreterConfigForTests: () => {},
}));
vi.mock('$lib/server/db/queries/skills', () => ({
	getEnabledSkillByName: (...a: unknown[]) => mocks.getEnabledSkillByName(...a),
}));
vi.mock('$lib/server/skills/disk-store', () => ({
	getSkillStore: () => mocks.store,
}));

import { activateSkillTool, readSkillFileTool } from '$lib/server/tools/activate-skill';
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

const REF = { id: 's1', name: 'review', description: 'd', storagePath: 'u1/review' };
const VALID_MD = '---\nname: review\ndescription: When reviewing.\n---\nDo the review thing.';

beforeEach(() => {
	mocks.getEnabledSkillByName.mockReset().mockReturnValue(REF);
	mocks.store.readSkillMd.mockReset().mockResolvedValue(VALID_MD);
	mocks.store.readFile.mockReset();
	mocks.store.listFiles.mockReset().mockResolvedValue(['SKILL.md']);
});

describe('activate_skill.execute', () => {
	it('returns the frontmatter-stripped body wrapped in <skill_content>', async () => {
		const r = await activateSkillTool.execute({ name: 'review' }, ctx());
		expect(r.isError).toBeUndefined();
		expect(r.content).toContain('<skill_content name="review">');
		expect(r.content).toContain('Do the review thing.');
		// Frontmatter is stripped, not echoed.
		expect(r.content).not.toContain('description: When reviewing.');
	});

	it('lists bundled resources (minus SKILL.md) in a <skill_resources> block', async () => {
		mocks.store.listFiles.mockResolvedValue([
			'SKILL.md',
			'references/api.md',
			'scripts/extract.py',
		]);
		const r = await activateSkillTool.execute({ name: 'review' }, ctx());
		expect(r.content).toContain('<skill_resources>');
		expect(r.content).toContain('- references/api.md');
		expect(r.content).toContain('- scripts/extract.py');
		// SKILL.md is the body itself, not a listed resource.
		expect(r.content).not.toContain('- SKILL.md');
	});

	it('omits the resources block when the bundle is SKILL.md only', async () => {
		const r = await activateSkillTool.execute({ name: 'review' }, ctx());
		expect(r.content).not.toContain('<skill_resources>');
	});

	it('refuses when skills are disabled for the conversation', async () => {
		const r = await activateSkillTool.execute(
			{ name: 'review' },
			ctx({ disabledFeatures: ['skills'] }),
		);
		expect(r.isError).toBe(true);
		expect(mocks.getEnabledSkillByName).not.toHaveBeenCalled();
	});

	it('errors on a missing/empty name', async () => {
		expect((await activateSkillTool.execute({}, ctx())).isError).toBe(true);
		expect((await activateSkillTool.execute({ name: '  ' }, ctx())).isError).toBe(true);
	});

	it('errors on an unknown skill', async () => {
		mocks.getEnabledSkillByName.mockReturnValue(null);
		const r = await activateSkillTool.execute({ name: 'ghost' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toContain('No enabled skill named "ghost"');
	});

	it('errors when the row exists but the bundle has no SKILL.md on disk', async () => {
		mocks.store.readSkillMd.mockResolvedValue(null);
		const r = await activateSkillTool.execute({ name: 'review' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toContain('has no SKILL.md');
	});
});

describe('read_skill_file.execute', () => {
	it('wraps the file text in <skill_file> with name + resolved path', async () => {
		mocks.store.readFile.mockResolvedValue({
			bytes: Buffer.from('# API reference', 'utf8'),
			relPath: 'references/api.md',
		});
		const r = await readSkillFileTool.execute({ name: 'review', path: 'references/api.md' }, ctx());
		expect(r.isError).toBeUndefined();
		expect(r.content).toBe(
			'<skill_file name="review" path="references/api.md">\n# API reference\n</skill_file>',
		);
	});

	it('refuses when skills are disabled', async () => {
		const r = await readSkillFileTool.execute(
			{ name: 'review', path: 'x.md' },
			ctx({ disabledFeatures: ['skills'] }),
		);
		expect(r.isError).toBe(true);
		expect(mocks.getEnabledSkillByName).not.toHaveBeenCalled();
	});

	it('errors on a missing path', async () => {
		expect((await readSkillFileTool.execute({ name: 'review' }, ctx())).isError).toBe(true);
	});

	it('errors on an unknown skill', async () => {
		mocks.getEnabledSkillByName.mockReturnValue(null);
		const r = await readSkillFileTool.execute({ name: 'ghost', path: 'x.md' }, ctx());
		expect(r.isError).toBe(true);
	});

	it('surfaces a path-jail throw as a recoverable isError result', async () => {
		mocks.store.readFile.mockRejectedValue(new Error('path escapes the skill directory'));
		const r = await readSkillFileTool.execute({ name: 'review', path: '../../etc/passwd' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toContain('escapes the skill directory');
	});

	it('errors when the file does not exist in the bundle', async () => {
		mocks.store.readFile.mockResolvedValue(null);
		const r = await readSkillFileTool.execute({ name: 'review', path: 'nope.md' }, ctx());
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content).error).toContain('No file at "nope.md"');
	});
});
