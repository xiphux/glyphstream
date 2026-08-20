/**
 * Extraction of the image prompt from an avatar-description reply.
 *
 * This exists because roleplay-tuned models stay in character first and answer
 * second — a paragraph of prose, THEN the description — and no phrasing of
 * "reply with only…" reliably stops it. Asking for a delimiter doesn't have to
 * stop it either; it just has to make the answer findable.
 */
import { describe, expect, it } from 'vitest';
import { AVATAR_DESCRIPTION_PROMPT, extractAvatarPrompt } from '$lib/avatar-prompt';

describe('extractAvatarPrompt', () => {
	it('drops in-character prose that precedes the description', () => {
		// The observed failure: the model answers as the character, then complies.
		const reply =
			'Ilya sets down his pen and considers the question.\n\n' +
			'<description>A weathered navigator in a heavy orange oilskin coat.</description>';
		expect(extractAvatarPrompt(reply)).toBe(
			'A weathered navigator in a heavy orange oilskin coat.',
		);
	});

	it('drops prose that follows it too', () => {
		const reply = '<description>Only this part.</description>\n\nHe smiles and turns away.';
		expect(extractAvatarPrompt(reply)).toBe('Only this part.');
	});

	it('takes the LAST block when a model emits more than one', () => {
		// Prose-then-description is the failure mode, so the answer is the tail.
		// With a single block the two rules agree, which is why last is safe.
		const reply =
			'<description>First attempt.</description>\n' +
			'Actually, let me revise.\n' +
			'<description>Second attempt.</description>';
		expect(extractAvatarPrompt(reply)).toBe('Second attempt.');
	});

	it('falls back to the whole reply when the model ignores the tags', () => {
		// Covers older conversations and models that simply will not comply. The
		// UI shows this for editing, so the fallback is a starting point rather
		// than a silent wrong answer.
		const reply = 'A weathered navigator in an orange coat, lit by a swinging lamp.';
		expect(extractAvatarPrompt(reply)).toBe(reply);
	});

	it('keeps the tail of a truncated reply', () => {
		// Hitting a token limit mid-description is exactly when the tail IS the
		// description; returning nothing would be the least useful answer.
		const reply = 'Some prose first.\n<description>A navigator, mid-sentence and cut off';
		expect(extractAvatarPrompt(reply)).toBe('A navigator, mid-sentence and cut off');
	});

	it('falls back rather than hand the image model an empty prompt', () => {
		const reply = '<description>   </description>';
		expect(extractAvatarPrompt(reply)).toBe(reply.trim());
	});

	it('tolerates casing and internal whitespace in the tags', () => {
		expect(extractAvatarPrompt('< Description >Caps and spaces.</ DESCRIPTION >')).toBe(
			'Caps and spaces.',
		);
	});

	it('trims surrounding whitespace', () => {
		expect(extractAvatarPrompt('<description>\n\n  Padded.  \n\n</description>')).toBe('Padded.');
	});

	it('asks for the delimiter it parses', () => {
		// The prompt and the parser have to agree; nothing else enforces that.
		expect(AVATAR_DESCRIPTION_PROMPT).toContain('<description></description>');
	});
});
