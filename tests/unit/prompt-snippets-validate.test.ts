import { describe, expect, it } from 'vitest';
import {
	MAX_BODY_LENGTH,
	MAX_NAME_LENGTH,
	MAX_TAGS,
	MAX_TAG_LENGTH,
	snippetCapViolation,
	validateCreateSnippet,
	validateUpdateSnippet,
} from '$lib/server/prompt-snippets/validate';

const ok = { name: 'Anime', body: 'a clean look' };

describe('validateCreateSnippet', () => {
	it('accepts a well-formed snippet and trims', () => {
		expect(validateCreateSnippet({ name: '  Anime  ', body: '  a look  ' })).toEqual({
			name: 'Anime',
			body: 'a look',
			kinds: [],
			tags: [],
		});
	});

	it('requires name and body', () => {
		expect(() => validateCreateSnippet({ body: 'x' })).toThrow();
		expect(() => validateCreateSnippet({ name: 'x' })).toThrow();
		expect(() => validateCreateSnippet({ name: '   ', body: 'x' })).toThrow();
	});

	it('enforces the length caps', () => {
		expect(() => validateCreateSnippet({ ...ok, name: 'n'.repeat(MAX_NAME_LENGTH + 1) })).toThrow();
		expect(() => validateCreateSnippet({ ...ok, body: 'x'.repeat(MAX_BODY_LENGTH + 1) })).toThrow();
		expect(() => validateCreateSnippet({ ...ok, name: 'n'.repeat(MAX_NAME_LENGTH) })).not.toThrow();
	});

	// Regression: a name occupies exactly one `## <name>` heading line, so a
	// newline in it can't be represented — on export it split the snippet in
	// two and renamed it to whatever followed the break. The settings form uses
	// a single-line input, but the API accepted any string.
	it('rejects a name containing a line break', () => {
		expect(() => validateCreateSnippet({ ...ok, name: 'Foo\n## Bar' })).toThrow();
		expect(() => validateCreateSnippet({ ...ok, name: 'Foo\r\nBar' })).toThrow();
	});

	// Regression: the guard used to be /[\r\n]/, but the format's line model —
	// and JS's `.` — recognize the full ECMAScript LineTerminator set. U+2028 is
	// the soft break word processors and PDFs emit, and an HTML input strips
	// only LF/CR, so it reaches the API from an ordinary paste.
	it('rejects the full line-terminator set in a name', () => {
		expect(() => validateCreateSnippet({ ...ok, name: 'Foo\u2028Bar' })).toThrow();
		expect(() => validateCreateSnippet({ ...ok, name: 'Foo\u2029Bar' })).toThrow();
	});

	// A body is legitimately multi-line, so terminators are NORMALIZED rather
	// than rejected — otherwise pasting a fragment out of a PDF would 400 over
	// an invisible character. Storing only LF is what makes the body identical
	// to what round-trips through the export format.
	it('normalizes line terminators in a body instead of rejecting them', () => {
		const body = 'first\u2028second\u2029third\rfourth\r\nfifth\nsixth';
		expect(validateCreateSnippet({ ...ok, body }).body).toBe(
			'first\nsecond\nthird\nfourth\nfifth\nsixth',
		);
	});

	// The ordering trap: a naive [\r\n...] class turns one CRLF into two LFs.
	it('collapses CRLF to a single newline, not two', () => {
		expect(validateCreateSnippet({ ...ok, body: 'a\r\nb' }).body).toBe('a\nb');
	});

	it('rejects the full line-terminator set in a tag', () => {
		expect(() => validateCreateSnippet({ ...ok, tags: ['a\u2028b'] })).toThrow();
		expect(() => validateCreateSnippet({ ...ok, tags: ['a\u2029b'] })).toThrow();
	});

	// The guard must stay narrow — these are NOT line terminators and are
	// legitimate in a name.
	it('allows other exotic whitespace and control characters', () => {
		for (const ch of ['\u000B', '\u000C', '\u0085', '\u00A0', '\u200B', '\u3000']) {
			expect(() => validateCreateSnippet({ ...ok, name: `Foo${ch}Bar` })).not.toThrow();
		}
	});

	it('allows a hash mid-name, which the heading line can represent', () => {
		expect(validateCreateSnippet({ ...ok, name: 'Foo ## Bar' }).name).toBe('Foo ## Bar');
	});

	it('rejects unknown kinds rather than silently dropping them', () => {
		expect(() => validateCreateSnippet({ ...ok, kinds: ['banana'] })).toThrow();
		expect(validateCreateSnippet({ ...ok, kinds: ['image', 'image'] }).kinds).toEqual(['image']);
	});

	it('de-dupes and caps tags', () => {
		expect(validateCreateSnippet({ ...ok, tags: ['a', 'a', ' b '] }).tags).toEqual(['a', 'b']);
		expect(() =>
			validateCreateSnippet({ ...ok, tags: [`${'z'.repeat(MAX_TAG_LENGTH + 1)}`] }),
		).toThrow();
	});

	// Regression: a tag occupies one line of the library format (`tags: a, b`),
	// comma-separated. A newline split the snippet on export — destroying the
	// real row and fabricating one that inherited its body. A comma silently
	// became two tags on re-import, which could push a legal 20-tag snippet
	// over the cap and make an exported library un-re-importable.
	it('rejects a tag containing a line break', () => {
		expect(() => validateCreateSnippet({ ...ok, tags: ['a\n## Injected'] })).toThrow();
		expect(() => validateCreateSnippet({ ...ok, tags: ['a\r\nb'] })).toThrow();
	});

	it('rejects a tag containing a comma, which separates tags', () => {
		expect(() => validateCreateSnippet({ ...ok, tags: ['8k, photorealistic'] })).toThrow();
	});

	// The guard is narrow on purpose — only the delimiter and the line
	// boundary break the format.
	it('still allows ordinary punctuation and spaces in a tag', () => {
		expect(validateCreateSnippet({ ...ok, tags: ['sci-fi', 'line art', "80's"] }).tags).toEqual([
			'sci-fi',
			'line art',
			"80's",
		]);
	});
});

describe('validateUpdateSnippet', () => {
	it('validates only the fields present', () => {
		expect(validateUpdateSnippet({ body: 'new' })).toEqual({ body: 'new' });
	});

	it('rejects an empty patch', () => {
		expect(() => validateUpdateSnippet({})).toThrow();
	});

	it('applies the same name rules', () => {
		expect(() => validateUpdateSnippet({ name: 'a\nb' })).toThrow();
	});
});

// The non-throwing counterpart the bulk importer uses, so one oversize entry
// is reported rather than failing a whole library.
describe('snippetCapViolation', () => {
	it('returns null for an entry within limits', () => {
		expect(snippetCapViolation({ name: 'A', body: 'b', tags: ['x'] })).toBeNull();
	});

	it('rejects a blank name, which the create path also rejects', () => {
		expect(snippetCapViolation({ name: '', body: 'b', tags: [] })).toMatch(/no name/);
		expect(snippetCapViolation({ name: '   ', body: 'b', tags: [] })).toMatch(/no name/);
	});

	it('names the field that is over', () => {
		expect(snippetCapViolation({ name: 'n'.repeat(201), body: 'b', tags: [] })).toMatch(/name/);
		expect(snippetCapViolation({ name: 'A', body: 'x'.repeat(8001), tags: [] })).toMatch(/body/);
		expect(
			snippetCapViolation({
				name: 'A',
				body: 'b',
				tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`),
			}),
		).toMatch(/tags/);
		expect(snippetCapViolation({ name: 'A', body: 'b', tags: ['z'.repeat(61)] })).toMatch(/tag/);
	});

	it('agrees with the throwing validator at the boundary', () => {
		const atCap = {
			name: 'n'.repeat(MAX_NAME_LENGTH),
			body: 'x'.repeat(MAX_BODY_LENGTH),
			tags: [],
		};
		expect(snippetCapViolation(atCap)).toBeNull();
		expect(() => validateCreateSnippet({ ...atCap })).not.toThrow();
	});
});
