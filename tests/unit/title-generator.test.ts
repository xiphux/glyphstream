import { describe, expect, it } from 'vitest';
import { buildTitlePrompt, sanitizeTitle } from '$lib/server/tasks/title-generator';

describe('buildTitlePrompt', () => {
	it('includes both user and assistant text for text chats', () => {
		const msgs = buildTitlePrompt({
			userText: 'What is TypeScript?',
			userMediaKinds: [],
			assistantText: 'A typed superset of JavaScript.',
			assistantHasMedia: false
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
			assistantHasMedia: false
		});
		expect(msgs).not.toBeNull();
		expect(msgs![1].content).toBe('a cat in a hat');
		expect(msgs![1].content).not.toContain('Assistant:');
	});

	it('uses prompt-only when assistant text is empty whitespace', () => {
		// Image branch lands here too — assistant message exists but has no
		// text parts, so .assistantText is '' or whitespace.
		const msgs = buildTitlePrompt({
			userText: 'sunset over mountains',
			userMediaKinds: [],
			assistantText: '   ',
			assistantHasMedia: true
		});
		expect(msgs!.length).toBe(2);
		expect(msgs![1].content).toBe('sunset over mountains');
	});

	it('truncates very long user text', () => {
		const long = 'x'.repeat(2000);
		const msgs = buildTitlePrompt({
			userText: long,
			userMediaKinds: [],
			assistantText: null,
			assistantHasMedia: false
		});
		// 500-char cap with ellipsis = at most 500 chars in the prompt
		expect(msgs![1].content.length).toBeLessThanOrEqual(500);
		expect(msgs![1].content.endsWith('…')).toBe(true);
	});

	it('returns null when nothing usable exists', () => {
		expect(
			buildTitlePrompt({
				userText: '',
				userMediaKinds: [],
				assistantText: null,
				assistantHasMedia: false
			})
		).toBeNull();
		expect(
			buildTitlePrompt({
				userText: '   ',
				userMediaKinds: [],
				assistantText: '\n\n',
				assistantHasMedia: false
			})
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
