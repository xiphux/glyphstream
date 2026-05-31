/**
 * Tests for the lazy client-side shiki module. The whole point of the
 * module is to gate highlighting on a dynamic chunk having landed — so
 * the surface to pin is:
 *
 *   - resolveLiveLang() — alias normalization + null for off-list langs.
 *   - highlightLiveCode() — returns null when no highlighter loaded;
 *     wraps the highlighter's codeToHtml when one is.
 *   - ensureLiveHighlighter() — idempotent (single in-flight promise).
 *
 * We don't actually exercise the dynamic shiki imports here — that's
 * what `tests/unit/markdown-render.test.ts` already does for the full
 * shiki bundle on the server. The point of THESE tests is that the
 * gating logic works regardless of what's in the bundle.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	ensureLiveHighlighter,
	getLiveHighlighter,
	highlightLiveCode,
	liveHighlighterReady,
	resetLiveHighlighterForTests,
	resolveLiveLang,
	setLiveHighlighterForTests,
} from '$lib/markdown-live-shiki.svelte';

afterEach(() => {
	resetLiveHighlighterForTests();
});

describe('resolveLiveLang', () => {
	it('returns python for python and py', () => {
		expect(resolveLiveLang('python')).toBe('python');
		expect(resolveLiveLang('py')).toBe('python');
		expect(resolveLiveLang('Python')).toBe('python');
		expect(resolveLiveLang('  PY  ')).toBe('python');
	});

	it('returns markdown for markdown and md', () => {
		expect(resolveLiveLang('markdown')).toBe('markdown');
		expect(resolveLiveLang('md')).toBe('markdown');
		expect(resolveLiveLang('MD')).toBe('markdown');
	});

	it('returns null for other languages', () => {
		expect(resolveLiveLang('javascript')).toBeNull();
		expect(resolveLiveLang('typescript')).toBeNull();
		expect(resolveLiveLang('json')).toBeNull();
		expect(resolveLiveLang('bash')).toBeNull();
		expect(resolveLiveLang('')).toBeNull();
		expect(resolveLiveLang(null)).toBeNull();
		expect(resolveLiveLang(undefined)).toBeNull();
	});
});

describe('highlightLiveCode (gating)', () => {
	it('returns null when no highlighter has been loaded yet', () => {
		expect(highlightLiveCode('print(1)', 'python')).toBeNull();
	});

	it('returns the highlighter output when one is loaded', () => {
		const fake = {
			codeToHtml: (code: string, opts: { lang: string }) =>
				`<pre data-lang="${opts.lang}">${code}</pre>`,
			// Cast through unknown — the test only needs codeToHtml; the
			// other HighlighterCore methods aren't reachable from
			// highlightLiveCode's code path.
		} as unknown as Parameters<typeof setLiveHighlighterForTests>[0];
		setLiveHighlighterForTests(fake);
		expect(highlightLiveCode('print(1)', 'python')).toBe('<pre data-lang="python">print(1)</pre>');
		expect(liveHighlighterReady.value).toBe(true);
		expect(getLiveHighlighter()).toBe(fake);
	});

	it('returns null when the highlighter throws', () => {
		const fake = {
			codeToHtml: () => {
				throw new Error('grammar edge case');
			},
		} as unknown as Parameters<typeof setLiveHighlighterForTests>[0];
		setLiveHighlighterForTests(fake);
		expect(highlightLiveCode('print(1)', 'python')).toBeNull();
	});
});

describe('ensureLiveHighlighter', () => {
	it('is idempotent — concurrent callers share a single in-flight promise', () => {
		const a = ensureLiveHighlighter();
		const b = ensureLiveHighlighter();
		expect(a).toBe(b);
	});

	it('subsequent calls after a resolution share the same resolved promise', async () => {
		const fake = {
			codeToHtml: () => '<pre></pre>',
		} as unknown as Parameters<typeof setLiveHighlighterForTests>[0];
		setLiveHighlighterForTests(fake);
		// After the test escape hatch, ensureLiveHighlighter() should see
		// the seeded promise and return it without trying to dynamic-import.
		await expect(ensureLiveHighlighter()).resolves.toBe(fake);
		await expect(ensureLiveHighlighter()).resolves.toBe(fake);
	});

	it('reset clears the singleton so the next call starts fresh', () => {
		const fake = {
			codeToHtml: () => '<pre></pre>',
		} as unknown as Parameters<typeof setLiveHighlighterForTests>[0];
		setLiveHighlighterForTests(fake);
		expect(getLiveHighlighter()).toBe(fake);
		resetLiveHighlighterForTests();
		expect(getLiveHighlighter()).toBeNull();
		expect(liveHighlighterReady.value).toBe(false);
	});
});
