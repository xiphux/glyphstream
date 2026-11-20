/**
 * Every `sql<number>` fragment in src/ carries `.mapWith(Number)`.
 *
 * From drizzle-orm 1.0.0-rc.6, node-sqlite reads every decoded query with
 * `setReadBigInts(true)`. Column codecs turn integers back into numbers, but a
 * raw `sql` select field has no codec, so without `.mapWith()` it arrives as a
 * `bigint` while still typed `number`. Nothing else notices: it type-checks, it
 * lints, and a test only fails if it happens to do arithmetic on the value or
 * serialize it — `1n + 1` and `JSON.stringify(1n)` throw, `1n === 1` is false.
 *
 * The rule is applied to every `sql<number>` rather than only to select fields:
 * one used in `.set()` never reaches the decoder, so the call is inert there,
 * and a fragment written for an update tends to get reused in a select later.
 * Untyped `sql\`…\`` select fields are not caught here.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(full));
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
	return out;
}

/** A `sql<…number…>` template (any union spelling) not followed by `.mapWith(`. */
const UNMAPPED = /sql<[^>]*\bnumber\b[^>]*>`[^`]*`(?!\.mapWith\()/g;

describe('sql<number> fragments', () => {
	it('all carry .mapWith(Number)', () => {
		const offenders: string[] = [];
		for (const file of tsFiles(SRC)) {
			const source = readFileSync(file, 'utf8');
			for (const m of source.matchAll(UNMAPPED)) {
				const line = source.slice(0, m.index).split('\n').length;
				offenders.push(`${relative(SRC, file)}:${line}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('the scan recognises every spelling of a numeric fragment', () => {
		const sample = [
			'a: sql<number>`count(*)`,',
			'b: sql<number | null>`nullif(x, 0)`,',
			'c: sql<number>`count(*)`.mapWith(Number),',
			'd: sql<number>`(\n  select 1\n)`,',
			'e: sql<null | number>`max(x)`,',
			'f: sql<string>`name`,',
		].join('\n');
		expect([...sample.matchAll(UNMAPPED)]).toHaveLength(4);
	});
});
