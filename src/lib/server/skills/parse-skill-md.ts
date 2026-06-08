/**
 * SKILL.md parser. A SKILL.md is YAML frontmatter between `---` fences
 * followed by a markdown body. We extract the required `name` + `description`
 * (cached into the DB catalog index) and return the body separately
 * (activate_skill ships it frontmatter-stripped).
 *
 * We parse the frontmatter with the `yaml` library rather than hand-rolling,
 * and retain the FULL parsed object — the agentskills.io spec defines optional
 * fields beyond name/description (`license`, `compatibility`, `allowed-tools`,
 * …) and keeps adding more, so a real parser keeps us forward-compatible and
 * handles YAML edge cases (quoted/folded values) a line scanner would botch.
 *
 * Validation philosophy follows the spec's "lenient" guidance — warn-but-load
 * on cosmetic issues, skip only when essentials are missing — with ONE
 * deliberate exception: `name` is load-bearing here (it's the on-disk directory
 * name AND the activation enum value), so we require it to be a filesystem- and
 * enum-safe slug rather than accepting and sanitizing it. That keeps the spec's
 * "frontmatter name matches parent directory" invariant true by construction.
 */

import { parse as parseYaml } from 'yaml';

/** Enum- and filesystem-safe skill name (the spec's canonical form). */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_SKILL_NAME_CHARS = 64;
export const MAX_SKILL_DESCRIPTION_CHARS = 1024;
/** Tier-2 body ceiling. A skill body is injected wholesale on activation, so
 *  an unbounded one could blow the context budget; the spec recommends keeping
 *  instructions under ~5k tokens. 16 KiB is a generous ceiling above that. */
export const MAX_SKILL_BODY_BYTES = 16 * 1024;

export interface ParsedSkill {
	name: string;
	description: string;
	/** The full parsed frontmatter object — unknown keys retained for forward
	 *  compatibility with the expanding spec. */
	frontmatter: Record<string, unknown>;
	/** Markdown body after the closing fence, trimmed (frontmatter stripped). */
	body: string;
}

export type ParseSkillResult = { ok: true; skill: ParsedSkill } | { ok: false; error: string };

const FRONTMATTER_FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/** Strip a leading UTF-8 BOM so the opening `---` matches at offset 0. */
function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Lenient fallback for the most common cross-client malformation: an unquoted
 * scalar containing a colon-space (`description: Use when: …`), which YAML
 * reads as a nested mapping and rejects. Wrap any such top-level value in
 * double quotes and let the caller retry the parse once.
 */
function quoteRiskyScalars(yamlText: string): string {
	return yamlText
		.split(/\r?\n/)
		.map((line) => {
			const m = /^([A-Za-z0-9_-]+):[ \t]+(.*\S)[ \t]*$/.exec(line);
			if (!m) return line;
			const [, key, value] = m;
			// Already quoted, a block scalar, or a flow collection — leave it.
			if (/^["'|>[{]/.test(value)) return line;
			// Only intervene when the value itself contains a colon-space, the
			// thing that breaks the naive parse.
			if (!/:\s/.test(value)) return line;
			const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			return `${key}: "${escaped}"`;
		})
		.join('\n');
}

function asString(v: unknown): string | null {
	return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

/**
 * Parse raw SKILL.md text. Pure — no I/O. Returns a structured error (surfaced
 * to the import UI) rather than throwing, so a malformed paste/upload is a 400
 * with a message, not a 500.
 */
export function parseSkillMd(raw: string): ParseSkillResult {
	const match = FRONTMATTER_FENCE.exec(stripBom(raw).trimStart());
	if (!match) {
		return {
			ok: false,
			error:
				'No YAML frontmatter found. A SKILL.md must begin with a `---` fenced block containing at least `name` and `description`.',
		};
	}

	const [, yamlBlock, bodyRaw = ''] = match;

	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = coerceObject(parseYaml(yamlBlock));
	} catch {
		try {
			frontmatter = coerceObject(parseYaml(quoteRiskyScalars(yamlBlock)));
		} catch (e) {
			return { ok: false, error: `Frontmatter is not valid YAML: ${(e as Error).message}` };
		}
	}

	const name = asString(frontmatter.name)?.trim() ?? '';
	if (!name) {
		return { ok: false, error: 'Frontmatter is missing a `name`.' };
	}
	if (name.length > MAX_SKILL_NAME_CHARS) {
		return {
			ok: false,
			error: `Skill name exceeds ${MAX_SKILL_NAME_CHARS} characters.`,
		};
	}
	if (!SKILL_NAME_PATTERN.test(name)) {
		return {
			ok: false,
			error: `Skill name "${name}" must be lowercase letters, digits, and hyphens only (e.g. "pdf-processing"). It is used as the skill's directory name and activation identifier.`,
		};
	}

	const description = asString(frontmatter.description)?.trim() ?? '';
	if (!description) {
		return { ok: false, error: 'Frontmatter is missing a `description`.' };
	}
	if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
		return {
			ok: false,
			error: `Skill description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} characters.`,
		};
	}

	const body = bodyRaw.trim();
	if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_BODY_BYTES) {
		return {
			ok: false,
			error: `SKILL.md body exceeds ${MAX_SKILL_BODY_BYTES} bytes. Keep skill instructions concise; move bulk content into separate reference files the model loads on demand.`,
		};
	}

	return { ok: true, skill: { name, description, frontmatter, body } };
}

function coerceObject(parsed: unknown): Record<string, unknown> {
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('frontmatter must be a mapping of fields');
	}
	return parsed as Record<string, unknown>;
}
