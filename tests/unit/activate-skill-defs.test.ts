import { beforeEach, describe, expect, it, vi } from 'vitest';

// run_skill_script is additionally gated on the code interpreter; control it.
const mocks = vi.hoisted(() => ({ ci: true }));
vi.mock('$lib/server/code-interpreter/config', () => ({
	isCodeInterpreterEnabled: () => mocks.ci,
	getCodeInterpreterConfig: () => ({}),
	resetCodeInterpreterConfigForTests: () => {},
}));

import {
	activateSkillDefinition,
	readSkillFileDefinition,
	runSkillScriptDefinition,
	skillToolDefinitions,
} from '$lib/server/tools/activate-skill';

beforeEach(() => {
	mocks.ci = true;
});

describe('activateSkillDefinition', () => {
	it('returns null when there are no skills (omit-when-empty)', () => {
		expect(activateSkillDefinition([])).toBeNull();
	});

	it('constrains the name parameter to the provided skill names', () => {
		const def = activateSkillDefinition(['pdf-processing', 'data-analysis'])!;
		expect(def.function.name).toBe('activate_skill');
		const props = def.function.parameters.properties as Record<string, { enum?: string[] }>;
		expect(props.name.enum).toEqual(['pdf-processing', 'data-analysis']);
		expect(def.function.parameters.required).toEqual(['name']);
	});
});

describe('readSkillFileDefinition', () => {
	it('returns null when there are no skills', () => {
		expect(readSkillFileDefinition([])).toBeNull();
	});

	it('enum-constrains name and takes a free-string path', () => {
		const def = readSkillFileDefinition(['x'])!;
		expect(def.function.name).toBe('read_skill_file');
		const props = def.function.parameters.properties as Record<
			string,
			{ enum?: string[]; type?: string }
		>;
		expect(props.name.enum).toEqual(['x']);
		expect(props.path.type).toBe('string');
		expect(props.path.enum).toBeUndefined();
		expect(def.function.parameters.required).toEqual(['name', 'path']);
	});
});

describe('runSkillScriptDefinition', () => {
	it('returns null when there are no skills', () => {
		expect(runSkillScriptDefinition([])).toBeNull();
	});

	it('enum-constrains name; takes a path + optional string[] args', () => {
		const def = runSkillScriptDefinition(['x'])!;
		expect(def.function.name).toBe('run_skill_script');
		const props = def.function.parameters.properties as Record<
			string,
			{ enum?: string[]; type?: string; items?: { type?: string } }
		>;
		expect(props.name.enum).toEqual(['x']);
		expect(props.path.type).toBe('string');
		expect(props.args.type).toBe('array');
		expect(props.args.items?.type).toBe('string');
		expect(def.function.parameters.required).toEqual(['name', 'path']);
	});
});

describe('skillToolDefinitions', () => {
	it('advertises all three tools when skills + the interpreter are available', () => {
		const defs = skillToolDefinitions(['a', 'b'], []);
		expect(defs.map((d) => d.function.name)).toEqual([
			'activate_skill',
			'read_skill_file',
			'run_skill_script',
		]);
	});

	it('omits run_skill_script when the interpreter is disabled server-wide', () => {
		mocks.ci = false;
		expect(skillToolDefinitions(['a'], []).map((d) => d.function.name)).toEqual([
			'activate_skill',
			'read_skill_file',
		]);
	});

	it('omits run_skill_script when the code_interpreter category is disabled', () => {
		expect(skillToolDefinitions(['a'], ['code_interpreter']).map((d) => d.function.name)).toEqual([
			'activate_skill',
			'read_skill_file',
		]);
	});

	it('omits everything when the skills category is disabled', () => {
		expect(skillToolDefinitions(['a'], ['skills'])).toEqual([]);
	});

	it('omits everything when there are no enabled skills', () => {
		expect(skillToolDefinitions([], [])).toEqual([]);
	});
});
