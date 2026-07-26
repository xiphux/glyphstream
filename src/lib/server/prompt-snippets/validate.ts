import { error } from '@sveltejs/kit';
import { isSnippetKind, type SnippetKind } from '$lib/types/api';

/** Same cap custom models use for `name`. */
const MAX_NAME_LENGTH = 200;
/** A style fragment is a paragraph or two; this is roomy but refuses a whole
 *  pasted document, which would belong in a skill rather than a snippet. */
export const MAX_BODY_LENGTH = 8000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 60;

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
	return name;
}

function validateBody(raw: unknown): string {
	const body = typeof raw === 'string' ? raw.trim() : '';
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
		if (!out.includes(tag)) out.push(tag);
	}
	if (out.length > MAX_TAGS) throw error(400, `At most ${MAX_TAGS} tags`);
	return out;
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
