import { describe, expect, it } from 'vitest';
import { buildTitlePrompt, sanitizeTitle } from '$lib/server/tasks/title-generator';

describe('buildTitlePrompt', () => {
	it('includes both user and assistant text for text chats', () => {
		const msgs = buildTitlePrompt({
			userText: 'What is TypeScript?',
			userMediaKinds: [],
			assistantText: 'A typed superset of JavaScript.',
			assistantHasMedia: false,
		});
		expect(msgs).not.toBeNull();
		expect(msgs!.length).toBe(2);
		expect(msgs![0].role).toBe('system');
		expect(msgs![1].role).toBe('user');
		expect(msgs![1].content).toContain('What is TypeScript?');
		expect(msgs![1].content).toContain('A typed superset of JavaScript.');
	});

	it('uses prompt-only when assistant text is missing (image/video case)', () => {
		const msgs = buildTitlePrompt({
			userText: 'a cat in a hat',
			userMediaKinds: [],
			assistantText: null,
			assistantHasMedia: false,
		});
		expect(msgs).not.toBeNull();
		expect(msgs![1].content).toContain('a cat in a hat');
		expect(msgs![1].content).not.toContain('Assistant:');
	});

	it('uses prompt-only when assistant text is empty whitespace', () => {
		// Image branch lands here too — assistant message exists but has no
		// text parts, so .assistantText is '' or whitespace.
		const msgs = buildTitlePrompt({
			userText: 'sunset over mountains',
			userMediaKinds: [],
			assistantText: '   ',
			assistantHasMedia: true,
		});
		expect(msgs!.length).toBe(2);
		expect(msgs![1].content).toContain('sunset over mountains');
		expect(msgs![1].content).not.toContain('Assistant:');
	});

	it('wraps the body in <conversation> tags with a trailing title instruction', () => {
		// Regression: weaker task models were continuing the assistant turn
		// instead of titling it (cliffhanger-completion). The wrapper marks
		// the body as data and the trailer pulls generation back on task.
		const msgs = buildTitlePrompt({
			userText: 'Write a story about a wizard named Alex',
			userMediaKinds: [],
			assistantText: 'In the misty hills of Eldoria, Alex pulled out his staff and',
			assistantHasMedia: false,
		});
		const body = msgs![1].content;
		expect(body).toContain('<conversation>');
		expect(body).toContain('</conversation>');
		// Trailing instruction must come after the closing tag, so the last
		// tokens before generation are "output a title."
		const closeIdx = body.indexOf('</conversation>');
		expect(body.indexOf('title', closeIdx)).toBeGreaterThan(closeIdx);
	});

	it('truncates very long user text', () => {
		const long = 'x'.repeat(2000);
		const msgs = buildTitlePrompt({
			userText: long,
			userMediaKinds: [],
			assistantText: null,
			assistantHasMedia: false,
		});
		// 500-char cap applies to the user-text portion (the wrapper + trailer
		// add fixed overhead). Verify the run of x's is bounded, not the full
		// prompt.
		const xRun = msgs![1].content.match(/x+…?/);
		expect(xRun).not.toBeNull();
		expect(xRun![0].length).toBeLessThanOrEqual(500);
		expect(xRun![0].endsWith('…')).toBe(true);
	});

	it('returns null when nothing usable exists', () => {
		expect(
			buildTitlePrompt({
				userText: '',
				userMediaKinds: [],
				assistantText: null,
				assistantHasMedia: false,
			}),
		).toBeNull();
		expect(
			buildTitlePrompt({
				userText: '   ',
				userMediaKinds: [],
				assistantText: '\n\n',
				assistantHasMedia: false,
			}),
		).toBeNull();
	});
});

describe('sanitizeTitle', () => {
	it('trims whitespace', () => {
		expect(sanitizeTitle('  Hello World  ')).toBe('Hello World');
	});

	it('strips surrounding ASCII double quotes', () => {
		expect(sanitizeTitle('"Quoted Title"')).toBe('Quoted Title');
	});

	it('strips surrounding ASCII single quotes', () => {
		expect(sanitizeTitle("'Title'")).toBe('Title');
	});

	it('strips surrounding smart quotes', () => {
		expect(sanitizeTitle('“Smart Quoted”')).toBe('Smart Quoted');
		expect(sanitizeTitle('‘French Style’')).toBe('French Style');
	});

	it('strips leading "Title:" label', () => {
		expect(sanitizeTitle('Title: A Good Name')).toBe('A Good Name');
		expect(sanitizeTitle('title - lowercase variant')).toBe('lowercase variant');
	});

	it('strips trailing sentence punctuation', () => {
		expect(sanitizeTitle('Some Topic.')).toBe('Some Topic');
		expect(sanitizeTitle('Question?')).toBe('Question');
		expect(sanitizeTitle('Excited!')).toBe('Excited');
	});

	it('collapses internal whitespace runs', () => {
		expect(sanitizeTitle('Two\n\nLines')).toBe('Two Lines');
		expect(sanitizeTitle('Spaces   between   words')).toBe('Spaces between words');
	});

	it('caps very long titles', () => {
		const garbage = 'X'.repeat(500);
		const result = sanitizeTitle(garbage);
		expect(result.length).toBeLessThanOrEqual(100);
		expect(result.endsWith('…')).toBe(true);
	});

	it('handles the common LLM-misbehavior chain in one pass', () => {
		expect(sanitizeTitle('  Title: "Some Topic."  ')).toBe('Some Topic');
	});

	it('returns empty string for fully-stripped input', () => {
		expect(sanitizeTitle('')).toBe('');
		expect(sanitizeTitle('   ')).toBe('');
		expect(sanitizeTitle('""')).toBe('');
	});

	it('keeps internal quotes intact (only strips matching outer pair)', () => {
		expect(sanitizeTitle('Mike\'s "thing"')).toBe('Mike\'s "thing"');
	});
});
