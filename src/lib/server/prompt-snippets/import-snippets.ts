/**
 * Bulk import of a prompt-snippet library file. Route-agnostic and
 * unit-testable: the HTTP layer only marshals the body and maps the result to
 * a status, exactly as `import-skill.ts` does.
 *
 * Bulk import is a v1 requirement, not a nice-to-have — the feature exists to
 * replace a hand-managed text file of ~100 fragments, and an import path that
 * made you retype them one at a time would be as cumbersome as the
 * 100-custom-models approach it's meant to avoid.
 */

import { getDb } from '$lib/server/db/client';
import { createPromptSnippet, updatePromptSnippet } from '$lib/server/db/queries/prompt-snippets';
import { promptSnippets } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { parseSnippetMarkdown } from './markdown';

/** Upper bound on one import. Generous next to a realistic library (~100)
 *  while still refusing a runaway paste. */
export const MAX_IMPORT_SNIPPETS = 500;

export type ImportSnippetsResult =
	| { ok: true; imported: number; updated: number; skipped: string[]; warnings: string[] }
	| { ok: false; status: number; error: string };

export interface ImportOptions {
	userId: string;
	content: string;
	/** Replace the body/kinds/tags of a same-named snippet instead of skipping it. */
	overwrite?: boolean;
}

export function importSnippets(opts: ImportOptions): ImportSnippetsResult {
	const { userId, content, overwrite = false } = opts;

	if (typeof content !== 'string' || content.trim() === '') {
		return { ok: false, status: 400, error: 'Import file is empty.' };
	}

	const parsed = parseSnippetMarkdown(content);
	if (parsed.snippets.length === 0) {
		return {
			ok: false,
			status: 400,
			error: 'No snippets found. Each snippet needs a "## Name" heading followed by its body.',
		};
	}
	if (parsed.snippets.length > MAX_IMPORT_SNIPPETS) {
		return {
			ok: false,
			status: 400,
			error: `Too many snippets in one import (${parsed.snippets.length}; max ${MAX_IMPORT_SNIPPETS}).`,
		};
	}

	const skipped = [...parsed.skipped];
	let imported = 0;
	let updated = 0;

	// One transaction for the whole library so a failure part-way can't leave
	// half an import behind. The query helpers take the `tx` because
	// node:sqlite won't promote a nested db.transaction() to a SAVEPOINT.
	getDb().transaction((tx) => {
		// De-dupe within the file itself before touching the DB — two blocks
		// with the same heading would otherwise trip the unique index.
		const seen = new Set<string>();
		for (const s of parsed.snippets) {
			if (seen.has(s.name)) {
				skipped.push(`${s.name}: duplicate heading in file`);
				continue;
			}
			seen.add(s.name);

			// Read through `tx`, not getDb(): the rows written earlier in this
			// same loop aren't committed yet, so the existence check has to see
			// the transaction's own writes.
			const existing = tx
				.select({ id: promptSnippets.id })
				.from(promptSnippets)
				.where(and(eq(promptSnippets.userId, userId), eq(promptSnippets.name, s.name)))
				.get();
			if (existing) {
				if (!overwrite) {
					skipped.push(`${s.name}: already exists`);
					continue;
				}
				updatePromptSnippet(
					existing.id,
					userId,
					{ body: s.body, kinds: s.kinds, tags: s.tags },
					tx,
				);
				updated++;
				continue;
			}

			createPromptSnippet({ userId, name: s.name, body: s.body, kinds: s.kinds, tags: s.tags }, tx);
			imported++;
		}
	});

	return { ok: true, imported, updated, skipped, warnings: parsed.warnings };
}
