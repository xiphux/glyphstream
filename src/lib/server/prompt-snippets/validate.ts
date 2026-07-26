import { error } from '@sveltejs/kit';
import { isSnippetKind, type SnippetKind } from '$lib/types/api';
import { LINE_BREAKS, normalizeLineBreaks } from './markdown';

/** Same cap custom models use for `name`. */
export const MAX_NAME_LENGTH = 200;
/** A style fragment is a paragraph or two; this is roomy but refuses a whole
 *  pasted document, which would belong in a skill rather than a snippet. */
export const MAX_BODY_LENGTH = 8000;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 60;

export interface ValidatedSnippet {
	name: string;
	body: string;
	kinds: SnippetKind[];
	tags: string[];
}

function validateName(raw: unknown): string {
	const name = typeof raw === 'string' ? raw.trim() : '';
	if (!name) throw error(400, "'name' is required");
	if (name.length > MAX_NAME_LENGTH) {
		throw error(400, `'name' must be ${MAX_NAME_LENGTH} characters or fewer`);
	}
	// A name occupies exactly one `## <name>` heading line in the library
	// format, so a line break in it can't be represented: on export it would
	// split the snippet in two and rename it to whatever followed the break.
	// The settings form uses a single-line input, but the API accepts any
	// string — and an HTML input only strips LF/CR, so a name pasted from a
	// word processor or PDF can still carry U+2028. LINE_BREAKS is the full set
	// the format's line model recognizes; see its definition for why.
	if (LINE_BREAKS.test(name)) throw error(400, "'name' must not contain line breaks");
	return name;
}

function validateBody(raw: unknown): string {
	// Unlike name and tags, a body is legitimately multi-line, so a line break
	// here is representable and meaningful — rejecting would 400 someone for
	// pasting a style fragment out of a PDF, over a character they can't see.
	// Normalize instead, so the stored body contains only the LF the format
	// round-trips. Belt-and-braces with the serializer's own line model: this
	// keeps the character out of the database, that one keeps a row already
	// holding it from splitting a snippet.
	const body = typeof raw === 'string' ? normalizeLineBreaks(raw).trim() : '';
	if (!body) throw error(400, "'body' is required");
	if (body.length > MAX_BODY_LENGTH) {
		throw error(400, `'body' must be ${MAX_BODY_LENGTH} characters or fewer`);
	}
	return body;
}

/** undefined/null → [] (generic). Unknown entries 400 loudly rather than being
 *  dropped: silently discarding a kind would turn a typo into "shows
 *  everywhere", the opposite of what the user asked for. */
export function validateKinds(raw: unknown): SnippetKind[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw error(400, "'kinds' must be an array");
	const out: SnippetKind[] = [];
	for (const entry of raw) {
		if (!isSnippetKind(entry)) throw error(400, `'kinds': unknown kind "${String(entry)}"`);
		if (!out.includes(entry)) out.push(entry);
	}
	return out;
}

export function validateTags(raw: unknown): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw error(400, "'tags' must be an array");
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string') throw error(400, "'tags' entries must be strings");
		const tag = entry.trim();
		if (!tag) continue;
		if (tag.length > MAX_TAG_LENGTH) {
			throw error(400, `'tags' entries must be ${MAX_TAG_LENGTH} characters or fewer`);
		}
		// Same reasoning as validateName, and for the same reason: the library
		// format gives tags exactly one line (`tags: a, b`), comma-separated. A
		// newline would split the snippet on export; a comma would silently
		// become two tags on re-import (and can push a legal 20-tag snippet
		// over the cap, making an exported library un-re-importable). The
		// settings form can produce neither — it reads a single-line input and
		// splits on commas — but the API accepts any string.
		if (LINE_BREAKS.test(tag)) throw error(400, "'tags' entries must not contain line breaks");
		if (tag.includes(',')) {
			throw error(400, "'tags' entries must not contain commas — commas separate tags");
		}
		if (!out.includes(tag)) out.push(tag);
	}
	if (out.length > MAX_TAGS) throw error(400, `At most ${MAX_TAGS} tags`);
	return out;
}

/**
 * Non-throwing size check for the bulk-import path.
 *
 * Import can't use the validators above: they `throw error(400, …)`, which
 * would fail a whole 100-entry library over one oversized row, against that
 * path's forgiving-by-design contract. But the caps still have to apply there
 * — a row imported over the limit can't afterwards be saved from the settings
 * form at all (the PATCH validates every field present, so even a rename trips
 * the body cap), and it rides the composer's session fetch in full.
 *
 * Returns a human-readable reason for the `skipped[]` channel, or null when
 * the entry is within limits.
 */
export function snippetCapViolation(s: {
	name: string;
	body: string;
	tags: string[];
}): string | null {
	// Emptiness, not just size: the parser trims a whitespace-only heading to
	// '', and a blank name is a row the create/edit path would reject.
	if (!s.name.trim()) return 'heading has no name';
	if (s.name.length > MAX_NAME_LENGTH) return `name over ${MAX_NAME_LENGTH} characters`;
	if (s.body.length > MAX_BODY_LENGTH) return `body over ${MAX_BODY_LENGTH} characters`;
	if (s.tags.length > MAX_TAGS) return `more than ${MAX_TAGS} tags`;
	if (s.tags.some((t) => t.length > MAX_TAG_LENGTH)) {
		return `tag over ${MAX_TAG_LENGTH} characters`;
	}
	return null;
}

export function validateCreateSnippet(body: Record<string, unknown>): ValidatedSnippet {
	return {
		name: validateName(body.name),
		body: validateBody(body.body),
		kinds: validateKinds(body.kinds),
		tags: validateTags(body.tags),
	};
}

/** PATCH semantics: only the fields actually present are validated + returned,
 *  so an omitted field is left untouched by the query layer. */
export function validateUpdateSnippet(body: Record<string, unknown>): Partial<ValidatedSnippet> {
	const out: Partial<ValidatedSnippet> = {};
	if (body.name !== undefined) out.name = validateName(body.name);
	if (body.body !== undefined) out.body = validateBody(body.body);
	if (body.kinds !== undefined) out.kinds = validateKinds(body.kinds);
	if (body.tags !== undefined) out.tags = validateTags(body.tags);
	if (Object.keys(out).length === 0) throw error(400, 'No fields to update');
	return out;
}
