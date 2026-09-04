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
import { parseEmojiArg, reactToMessageTool, validateEmoji } from '$lib/server/tools/react';
import type { ToolContext } from '$lib/server/tools/types';

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

describe('reactToMessageTool.execute', () => {
	const ctx = (disabledFeatures: string[]): ToolContext => ({
		userId: 'u1',
		conversationId: 'c1',
		signal: new AbortController().signal,
		disabledFeatures,
	});

	it('returns the validated emoji as a live-tick side channel', () => {
		expect(reactToMessageTool.execute({ emoji: '🎉' }, ctx([]))).toEqual({
			content: 'ok',
			reaction: '🎉',
		});
	});

	it('refuses when the conversation turned reactions off', () => {
		// The registry filter only controls advertisement, and executeOneToolCall
		// resolves a tool by name without checking what this turn offered — so a
		// model copying its own past reactions out of the history would otherwise
		// sail straight past a toggle the user just switched off.
		const result = reactToMessageTool.execute({ emoji: '🎉' }, ctx(['reactions']));
		expect(result).toMatchObject({ isError: true });
		expect(result).not.toHaveProperty('reaction');
	});

	it('reports an invalid emoji to the model without surfacing a reaction', () => {
		const result = reactToMessageTool.execute({ emoji: ':+1:' }, ctx([]));
		expect(result).toMatchObject({ isError: true });
		expect(result).not.toHaveProperty('reaction');
	});
});
