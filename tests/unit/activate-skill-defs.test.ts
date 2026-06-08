import { describe, expect, it } from 'vitest';
import {
	activateSkillDefinition,
	readSkillFileDefinition,
	skillToolDefinitions,
} from '$lib/server/tools/activate-skill';

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

describe('skillToolDefinitions', () => {
	it('advertises both tools when a user has enabled skills', () => {
		const defs = skillToolDefinitions(['a', 'b'], []);
		expect(defs.map((d) => d.function.name)).toEqual(['activate_skill', 'read_skill_file']);
	});

	it('omits everything when the skills category is disabled', () => {
		expect(skillToolDefinitions(['a'], ['skills'])).toEqual([]);
	});

	it('omits everything when there are no enabled skills', () => {
		expect(skillToolDefinitions([], [])).toEqual([]);
	});
});
