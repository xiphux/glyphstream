import { describe, expect, it } from 'vitest';
import { stripReasoningTags } from '$lib/server/util/reasoning-tags';
import { sanitizeTitle } from '$lib/server/tasks/title-generator';
import { sanitizeEnhanced } from '$lib/server/streaming/prompt-enhancer';

describe('stripReasoningTags', () => {
	it('drops a complete block including its contents', () => {
		expect(stripReasoningTags('<think>the user wants a title</think>Kyoto Trip Planning')).toBe(
			'Kyoto Trip Planning',
		);
		expect(stripReasoningTags('Kyoto Trip Planning<think>hmm, better?</think>')).toBe(
			'Kyoto Trip Planning',
		);
	});

	it('drops a widowed closing tag but keeps the answer', () => {
		// The measured failure: reasoning suppressed with --reasoning-budget 0, the
		// closing tag emitted anyway, straight into the user's sidebar.
		expect(stripReasoningTags('Brotli vs. Gzip Compression </think>')).toBe(
			'Brotli vs. Gzip Compression',
		);
		expect(stripReasoningTags('<think>Svelte $effect re-runs twice')).toBe(
			'Svelte $effect re-runs twice',
		);
	});

	it('handles the tag-name variants and whitespace inside the tag', () => {
		expect(stripReasoningTags('<thinking>x</thinking>Title Here')).toBe('Title Here');
		expect(stripReasoningTags('<reasoning>x</reasoning>Title Here')).toBe('Title Here');
		expect(stripReasoningTags('Title Here</think >')).toBe('Title Here');
	});

	it('does not merge two blocks and swallow the text between them', () => {
		expect(stripReasoningTags('<think>a</think>Real Title<think>b</think>')).toBe('Real Title');
	});

	it('returns empty when the response was nothing but reasoning', () => {
		// Callers treat empty as failure: the title keeps its fallback, the enhancer
		// keeps the user's prompt.
		expect(stripReasoningTags('<think>I am not sure what to say</think>')).toBe('');
	});

	it('preserves multi-line structure — blank lines included', () => {
		// multimodal-script's three labeled fields are separated by REQUIRED blank
		// lines, and the enhancer's fenced-block strip needs the newlines too.
		const script =
			'<think>ok</think>integrated_multimodal_description: [Shot 1] a chef plates\n\noverall_soundscape: pans clatter\n\nnon_diegetic_music: N/A';
		expect(stripReasoningTags(script)).toBe(
			'integrated_multimodal_description: [Shot 1] a chef plates\n\noverall_soundscape: pans clatter\n\nnon_diegetic_music: N/A',
		);
	});

	it('leaves ordinary text alone, angle brackets included', () => {
		expect(stripReasoningTags('Comparing <T> generics in TypeScript')).toBe(
			'Comparing <T> generics in TypeScript',
		);
	});
});

describe('the sanitizers apply it', () => {
	it('keeps a stray tag out of a conversation title', () => {
		expect(sanitizeTitle('Brotli vs. Gzip Compression </think>')).toBe(
			'Brotli vs. Gzip Compression',
		);
		expect(sanitizeTitle('<think>what is this about</think>"Kyoto Trip Planning"')).toBe(
			'Kyoto Trip Planning',
		);
	});

	it('keeps a stray tag out of an enhanced image prompt', () => {
		expect(sanitizeEnhanced('<think>booru wants tags</think>1girl, solo, forest')).toBe(
			'1girl, solo, forest',
		);
		expect(sanitizeEnhanced('1girl, solo, forest </think>')).toBe('1girl, solo, forest');
	});
});
