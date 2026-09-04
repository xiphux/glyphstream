/**
 * `react_to_message` argument validation.
 *
 * The emoji lands in the UI as an unescaped grapheme on a message bubble, and
 * it comes from a model that was asked politely for "one emoji" — so the guard
 * is the only thing between a helpful 8B model's "😄 (a happy face!)" and a
 * badge full of prose. These cases are the ones that actually came up in
 * design: multi-emoji, prose, flags, keycaps, and the two legitimately-multi-
 * codepoint forms (skin tone, ZWJ family) that must NOT be rejected.
 */

import { describe, expect, it } from 'vitest';
import { parseEmojiArg, validateEmoji } from '$lib/server/tools/react';

describe('validateEmoji', () => {
	it.each(['😄', '❤️', '👍', '🙂', '⭐', '✅', '‼️'])('accepts %s', (emoji) => {
		expect(validateEmoji(emoji)).toBe(emoji);
	});

	it('accepts a skin-tone modifier as one reaction', () => {
		// Two code points, one grapheme.
		expect(validateEmoji('👍🏽')).toBe('👍🏽');
	});

	it('accepts a ZWJ sequence as one reaction', () => {
		expect(validateEmoji('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
	});

	it('trims surrounding whitespace', () => {
		expect(validateEmoji('  🙂 ')).toBe('🙂');
	});

	it.each([
		['empty', ''],
		['whitespace only', '   '],
		['a letter', 'a'],
		['a word', 'heart'],
		['two emoji', '😄😄'],
		['emoji plus commentary', '😄 nice one'],
		// Single graphemes that are not pictographic — they'd pass a naive
		// grapheme-count check and render as junk on a bubble.
		['a flag', '🇺🇸'],
		['a keycap', '1️⃣'],
		// A model that ignores the schema and narrates into the field.
		['a sentence', 'I would react with a smiling face here'],
	])('rejects %s', (_label, input) => {
		expect(validateEmoji(input)).toBeNull();
	});
});

describe('parseEmojiArg', () => {
	it('reads the emoji field', () => {
		expect(parseEmojiArg({ emoji: '🎉' })).toBe('🎉');
	});

	it.each([
		['null args', null],
		['a non-object', 'smile'],
		['a missing field', { mood: 'happy' }],
		['a non-string field', { emoji: 42 }],
	])('rejects %s', (_label, args) => {
		expect(parseEmojiArg(args)).toBeNull();
	});
});
