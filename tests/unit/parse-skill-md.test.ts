import { describe, expect, it } from 'vitest';
import {
	MAX_SKILL_BODY_BYTES,
	MAX_SKILL_NAME_CHARS,
	parseSkillMd,
} from '$lib/server/skills/parse-skill-md';

function ok(raw: string) {
	const r = parseSkillMd(raw);
	if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
	return r.skill;
}

describe('parseSkillMd — happy path', () => {
	it('extracts name, description, and body', () => {
		const skill = ok(`---
name: pdf-processing
description: Extract text from PDFs. Use when handling PDF files.
---

# PDF Processing

Do the thing.`);
		expect(skill.name).toBe('pdf-processing');
		expect(skill.description).toBe('Extract text from PDFs. Use when handling PDF files.');
		expect(skill.body).toBe('# PDF Processing\n\nDo the thing.');
	});

	it('retains unknown frontmatter fields for forward-compat', () => {
		const skill = ok(`---
name: data-analysis
description: Analyze datasets.
license: MIT
allowed-tools: [run_python]
---
body`);
		expect(skill.frontmatter.license).toBe('MIT');
		expect(skill.frontmatter['allowed-tools']).toEqual(['run_python']);
	});

	it('strips a leading UTF-8 BOM', () => {
		const skill = ok(`﻿---\nname: x\ndescription: d\n---\nbody`);
		expect(skill.name).toBe('x');
	});

	it('tolerates leading whitespace before the opening fence', () => {
		const skill = ok(`\n\n---\nname: x\ndescription: d\n---\nbody`);
		expect(skill.name).toBe('x');
	});

	it('handles an empty body', () => {
		const skill = ok(`---\nname: x\ndescription: d\n---\n`);
		expect(skill.body).toBe('');
	});

	it('accepts a quoted description containing a colon', () => {
		const skill = ok(`---\nname: x\ndescription: "Use when: handling PDFs"\n---\nbody`);
		expect(skill.description).toBe('Use when: handling PDFs');
	});
});

describe('parseSkillMd — lenient YAML recovery', () => {
	it('recovers an unquoted colon-space value by quoting and retrying', () => {
		// Technically-invalid YAML other clients tolerate.
		const skill = ok(
			`---\nname: x\ndescription: Use this skill when: the user asks about PDFs\n---\nbody`,
		);
		expect(skill.description).toBe('Use this skill when: the user asks about PDFs');
	});
});

describe('parseSkillMd — rejections', () => {
	it('rejects missing frontmatter', () => {
		const r = parseSkillMd('# just markdown, no frontmatter');
		expect(r.ok).toBe(false);
	});

	it('rejects a missing name', () => {
		const r = parseSkillMd(`---\ndescription: d\n---\nbody`);
		expect(r).toMatchObject({ ok: false });
	});

	it('rejects a missing description', () => {
		const r = parseSkillMd(`---\nname: x\n---\nbody`);
		expect(r).toMatchObject({ ok: false });
	});

	it('rejects a name with invalid characters (it is a directory + enum value)', () => {
		for (const bad of ['My Skill', 'UPPER', 'has_underscore', '../escape', 'name.dot']) {
			const r = parseSkillMd(`---\nname: ${bad}\ndescription: d\n---\nbody`);
			expect(r.ok, `name "${bad}" should be rejected`).toBe(false);
		}
	});

	it('rejects a name over the length cap', () => {
		const longName = 'a'.repeat(MAX_SKILL_NAME_CHARS + 1);
		const r = parseSkillMd(`---\nname: ${longName}\ndescription: d\n---\nbody`);
		expect(r.ok).toBe(false);
	});

	it('rejects an oversize body', () => {
		const body = 'x'.repeat(MAX_SKILL_BODY_BYTES + 1);
		const r = parseSkillMd(`---\nname: x\ndescription: d\n---\n${body}`);
		expect(r.ok).toBe(false);
	});
});
