/**
 * The code block a reply is still writing is re-rendered every animation frame
 * while it streams. Highlighting it from its first line each time made a long
 * Python block cost block-size x frames: three 100-line blocks spent ~16 s of
 * main-thread JS in shiki. `highlightLiveStream` keeps each finished line's
 * HTML and grammar state, so a frame tokenizes only what arrived since the last.
 *
 * Two things are pinned, against the real client subset: the work per frame
 * stays bounded by the new text (not the block), and the output at every step
 * is byte-identical to a full highlight — so the block never re-colors as it
 * grows, nor when the persisted server HTML replaces it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HighlighterCore } from '@shikijs/types';
import { ensureLiveMarkdown, renderLiveMarkdown } from '#lib/markdown-live.js';
import {
	ensureLiveHighlighter,
	highlightLiveCode,
	highlightLiveStream,
	resetLiveHighlighterForTests,
	setLiveHighlighterForTests,
} from '#lib/markdown-live-shiki.svelte.js';

// Constructs whose grammar state spans lines: a triple-quoted string, an open
// bracket, a decorator, a line continuation.
const PYTHON = [
	'import math',
	'from dataclasses import dataclass',
	'',
	'@dataclass',
	'class Circle:',
	'    """A circle.',
	'',
	'    Spans lines, so the grammar state carries "string" across them.',
	'    """',
	'    r: float',
	'',
	'    def area(self) -> float:',
	"        return math.pi * self.r ** 2  # squared, 'quoted'",
	'',
	'values = [',
	'    Circle(1.0),',
	'    Circle(2.5),',
	']',
	'total = sum(c.area() for c in values) \\',
	'    + 0',
	'print(f"{total:.2f} <&> done")',
].join('\n');

const MARKDOWN = [
	'# Title',
	'',
	'Some *emphasis* that',
	'continues here, and `code`.',
	'',
	'```python',
	'x = 1',
	'```',
	'',
	'- [link](https://example.com)',
].join('\n');

let real: HighlighterCore;

beforeAll(async () => {
	resetLiveHighlighterForTests();
	await ensureLiveMarkdown();
	const h = await ensureLiveHighlighter();
	if (!h) throw new Error('client highlighter failed to load');
	real = h;
}, 30_000);

afterAll(() => {
	resetLiveHighlighterForTests();
});

/** A fresh copy of the real highlighter that records what it tokenizes. */
function countingHighlighter(): string[] {
	const inputs: string[] = [];
	setLiveHighlighterForTests({
		...real,
		codeToHtml: (code, opts) => {
			inputs.push(code);
			return real.codeToHtml(code, opts);
		},
	});
	return inputs;
}

describe('highlightLiveStream output', () => {
	it.each([
		['python', PYTHON],
		['markdown', MARKDOWN],
	] as const)(
		'matches a full highlight at every character of a streamed %s block',
		(lang, code) => {
			setLiveHighlighterForTests({ ...real });
			const full = code + '\n';
			for (let i = 1; i <= full.length; i++) {
				const prefix = full.slice(0, i);
				const streamed = highlightLiveStream(prefix, lang);
				if (streamed !== highlightLiveCode(prefix, lang)) {
					expect(streamed, `diverged after ${JSON.stringify(prefix.slice(-40))}`).toBe(
						highlightLiveCode(prefix, lang),
					);
				}
			}
		},
	);

	it('leaves the closed fence exactly as a one-shot render would', () => {
		setLiveHighlighterForTests({ ...real });
		const doc = 'Here:\n\n```python\n' + PYTHON + '\n```\n\nDone.';
		for (let i = 1; i <= doc.length; i += 5) renderLiveMarkdown(doc.slice(0, i));
		expect(renderLiveMarkdown(doc)).toContain(highlightLiveCode(PYTHON + '\n', 'python')!);
	});

	it('keeps concurrent streams (fan-out columns) apart', () => {
		setLiveHighlighterForTests({ ...real });
		const a = PYTHON;
		const b = PYTHON.replace('import math', 's = """open').replace('print(', '"""\nprint(');
		for (let i = 1; i <= Math.max(a.length, b.length); i += 3) {
			for (const code of [a.slice(0, i), b.slice(0, i)]) {
				expect(highlightLiveStream(code, 'python')).toBe(highlightLiveCode(code, 'python'));
			}
		}
	});
});

describe('highlightLiveStream work', () => {
	const LONG = Array.from({ length: 10 }, () => PYTHON).join('\n\n');

	it('tokenizes a streamed block a line at a time, not from its start every frame', () => {
		const inputs = countingHighlighter();
		const doc = 'Intro.\n\n```python\n' + LONG + '\n```';
		const CHUNK = 9;
		const longestLine = Math.max(...LONG.split('\n').map((l) => l.length));
		let frames = 0;
		let worstFrame = 0;
		for (let i = CHUNK; i < doc.length + CHUNK; i += CHUNK) {
			const before = inputs.length;
			renderLiveMarkdown(doc.slice(0, i));
			frames++;
			const chars = inputs.slice(before).reduce((n, s) => n + s.length, 0);
			worstFrame = Math.max(worstFrame, chars);
		}
		const total = inputs.reduce((n, s) => n + s.length, 0);
		// Each finished line once, plus the line in progress once per frame.
		expect(total).toBeLessThan(LONG.length + frames * longestLine);
		expect(worstFrame).toBeLessThanOrEqual(CHUNK + 2 * longestLine);
	});
});
