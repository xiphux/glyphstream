import { describe, expect, it } from 'vitest';
import {
	filterSkillCommands,
	parseLeadingSkillToken,
	skillMenuQuery,
	stripSkillCommand,
} from '$lib/skill-command';

const SKILLS = [{ name: 'review' }, { name: 'research-topic' }, { name: 'pdf' }];

describe('parseLeadingSkillToken', () => {
	it('splits a command and its trailing message', () => {
		expect(parseLeadingSkillToken('/review check this')).toEqual({
			token: 'review',
			rest: 'check this',
		});
	});

	it('handles a bare command (no message)', () => {
		expect(parseLeadingSkillToken('/review')).toEqual({ token: 'review', rest: '' });
		expect(parseLeadingSkillToken('/review ')).toEqual({ token: 'review', rest: '' });
	});

	it('returns null for non-commands', () => {
		expect(parseLeadingSkillToken('hello')).toBeNull();
		expect(parseLeadingSkillToken('')).toBeNull();
		expect(parseLeadingSkillToken('/ spaced')).toBeNull();
	});

	it('returns null for a path-like token with a second slash', () => {
		expect(parseLeadingSkillToken('/etc/passwd')).toBeNull();
	});
});

describe('skillMenuQuery', () => {
	it('returns the in-progress prefix while typing the name', () => {
		expect(skillMenuQuery('/')).toBe('');
		expect(skillMenuQuery('/rev')).toBe('rev');
		expect(skillMenuQuery('/research-topic')).toBe('research-topic');
	});

	it('closes (null) once a space or second slash is typed, or no leading slash', () => {
		expect(skillMenuQuery('/review ')).toBeNull();
		expect(skillMenuQuery('/review check')).toBeNull();
		expect(skillMenuQuery('/etc/x')).toBeNull();
		expect(skillMenuQuery('hello')).toBeNull();
		expect(skillMenuQuery('')).toBeNull();
	});
});

describe('filterSkillCommands', () => {
	it('prefix-matches case-insensitively, preserving order', () => {
		expect(filterSkillCommands(SKILLS, 're').map((s) => s.name)).toEqual([
			'review',
			'research-topic',
		]);
		expect(filterSkillCommands(SKILLS, 'PD').map((s) => s.name)).toEqual(['pdf']);
	});

	it('returns all for an empty query (bare slash)', () => {
		expect(filterSkillCommands(SKILLS, '')).toHaveLength(3);
	});

	it('returns none when nothing matches', () => {
		expect(filterSkillCommands(SKILLS, 'zzz')).toEqual([]);
	});
});

describe('stripSkillCommand', () => {
	it('strips a matching leading command and activates it', () => {
		expect(stripSkillCommand('/review please check', SKILLS)).toEqual({
			text: 'please check',
			activatedSkillNames: ['review'],
		});
	});

	it('keeps the command text for a bare command (still sendable) and activates it', () => {
		expect(stripSkillCommand('/review', SKILLS)).toEqual({
			text: '/review',
			activatedSkillNames: ['review'],
		});
	});

	it('leaves a non-matching token untouched (no activation)', () => {
		expect(stripSkillCommand('/unknown do thing', SKILLS)).toEqual({
			text: '/unknown do thing',
			activatedSkillNames: [],
		});
	});

	it('leaves a path-like token untouched', () => {
		expect(stripSkillCommand('/etc/passwd', SKILLS)).toEqual({
			text: '/etc/passwd',
			activatedSkillNames: [],
		});
	});

	it('leaves ordinary text untouched', () => {
		expect(stripSkillCommand('hello there', SKILLS)).toEqual({
			text: 'hello there',
			activatedSkillNames: [],
		});
	});

	it('matches exactly (case-sensitive slug), not a prefix', () => {
		expect(stripSkillCommand('/Review hi', SKILLS).activatedSkillNames).toEqual([]);
		expect(stripSkillCommand('/rev hi', SKILLS).activatedSkillNames).toEqual([]);
	});
});
