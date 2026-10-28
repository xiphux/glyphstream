/**
 * The typed-reaction catch (leading-reaction.ts): a reply that opens with a lone
 * emoji on its own line becomes a `react_to_message` call. It rewrites what the
 * model wrote, so the cases it must NOT take matter as much as the ones it must.
 */

import { describe, expect, it } from 'vitest';
import {
	catchLeadingReaction,
	classifyLeadingText,
	syntheticReactionId,
} from '#lib/server/streaming/leading-reaction.js';
import type {
	NormalizedDelta,
	NormalizedResult,
	StreamNormalizer,
} from '#lib/server/streaming/normalizers.js';
import type { SSERecord } from '#lib/server/streaming/sse-parser.js';

/** An inner normalizer that replays canned results, one per `process` call. */
function scripted(
	results: NormalizedResult[],
	flushed: NormalizedResult = { deltas: [] },
): StreamNormalizer {
	let i = 0;
	return {
		process: () => results[i++] ?? { deltas: [] },
		flush: () => flushed,
	};
}

const text = (t: string): NormalizedDelta => ({ type: 'text', text: t });
const record = {} as SSERecord;

/** Run the wrapper over text chunks (one per process call) and a finish reason
 *  on the last; return every delta it emitted plus the finish reason it reports. */
function run(chunks: string[], finishReason: string | null = 'stop') {
	const results: NormalizedResult[] = chunks.map((c, i) => ({
		deltas: [text(c)],
		...(i === chunks.length - 1 ? { finishReason } : {}),
	}));
	const norm = catchLeadingReaction(scripted(results), 'call_x');
	const deltas: NormalizedDelta[] = [];
	let finish: string | null | undefined;
	for (let i = 0; i < results.length; i++) {
		const r = norm.process(record);
		deltas.push(...r.deltas);
		if (r.finishReason !== undefined) finish = r.finishReason;
	}
	deltas.push(...norm.flush().deltas);
	const joined = deltas.flatMap((d) => (d.type === 'text' ? [d.text] : [])).join('');
	const reaction = deltas.find((d) => d.type === 'tool_call_args_delta');
	return {
		deltas,
		text: joined,
		emoji: reaction ? (JSON.parse(reaction.argumentsDelta) as { emoji: string }).emoji : null,
		finish,
	};
}

describe('classifyLeadingText', () => {
	it('releases plain text on its first character', () => {
		expect(classifyLeadingText('H')).toEqual({ kind: 'release' });
	});

	it('holds an emoji until something follows it, since the grapheme can still grow', () => {
		expect(classifyLeadingText('❤')).toEqual({ kind: 'hold' });
		expect(classifyLeadingText('❤️')).toEqual({ kind: 'hold' });
	});

	it('holds through the blank line and waits for the reply to start', () => {
		expect(classifyLeadingText('❤️\n')).toEqual({ kind: 'hold' });
		expect(classifyLeadingText('❤️\n\n')).toEqual({ kind: 'hold' });
		expect(classifyLeadingText('❤️\n\nO')).toEqual({ kind: 'react', emoji: '❤️', rest: 'O' });
	});

	it('releases an emoji that opens a sentence', () => {
		expect(classifyLeadingText('🎉 That')).toEqual({ kind: 'release' });
	});

	it('releases an emoji followed by a single newline and text', () => {
		expect(classifyLeadingText('🎉\nCongrats')).toEqual({ kind: 'release' });
	});

	it('releases structural symbols', () => {
		expect(classifyLeadingText('⚠️\n\nThis deletes')).toEqual({ kind: 'release' });
		expect(classifyLeadingText('✅\n\nDone')).toEqual({ kind: 'release' });
	});

	it('releases two emoji', () => {
		expect(classifyLeadingText('❤️❤️\n\nHi')).toEqual({ kind: 'release' });
	});

	it('does not let the hold cap stop a reply that arrived in one chunk', () => {
		const long = `❤️\n\n${'a'.repeat(200)}`;
		expect(classifyLeadingText(long)).toMatchObject({ kind: 'react', emoji: '❤️' });
	});
});

describe('catchLeadingReaction', () => {
	it('turns a typed leading emoji into a reaction and keeps the reply', () => {
		const r = run(['❤️', '\n\n', 'Oh, Chris.', ' Come here.']);
		expect(r.emoji).toBe('❤️');
		expect(r.text).toBe('Oh, Chris. Come here.');
		expect(r.deltas[0]).toEqual({
			type: 'tool_call_start',
			toolCallId: 'call_x',
			toolName: 'react_to_message',
			index: -1,
		});
	});

	it('reports a stop as tool_calls, so the relay runs the tool', () => {
		expect(run(['🥹\n\nYou say that…']).finish).toBe('tool_calls');
	});

	it("reports a vendor's own finish reason as tool_calls too", () => {
		expect(run(['🥹\n\nYou say that…'], 'eos_token').finish).toBe('tool_calls');
	});

	it('supplies tool_calls on [DONE] when the upstream never sent a finish reason', () => {
		const norm = catchLeadingReaction(
			scripted([{ deltas: [text('🥹\n\nYou say that…')] }, { deltas: [], done: true }]),
			'call_x',
		);
		expect(norm.process(record).finishReason).toBeUndefined();
		expect(norm.process(record).finishReason).toBe('tool_calls');
	});

	it('keeps content_filter, which says the reply did not complete', () => {
		expect(run(['🥹\n\nYou say'], 'content_filter').finish).toBe('content_filter');
	});

	it('leaves the finish reason of an ordinary reply alone', () => {
		expect(run(['Hello'], 'eos_token').finish).toBe('eos_token');
	});

	it('keeps a length finish, which the relay will not execute', () => {
		expect(run(['🥹\n\nYou say'], 'length').finish).toBe('length');
	});

	it('assembles a ZWJ emoji split across tokens', () => {
		// 🧑‍💻 arrives as base, joiner, then the second pictograph.
		const r = run(['\u{1F9D1}', '‍', '\u{1F4BB}', '\n\nHi']);
		expect(r.emoji).toBe('\u{1F9D1}‍\u{1F4BB}');
		expect(r.text).toBe('Hi');
	});

	it('assembles a skin-toned emoji split across tokens', () => {
		const r = run(['👍', '🏽', '\n\nNice']);
		expect(r.emoji).toBe('👍🏽');
	});

	it('allows leading whitespace before the emoji', () => {
		expect(run(['\n🫂\n\nCome here.']).emoji).toBe('🫂');
	});

	it('leaves a reply that is only an emoji alone', () => {
		const r = run(['🚀']);
		expect(r.emoji).toBeNull();
		expect(r.text).toBe('🚀');
		expect(r.finish).toBe('stop');
	});

	it('leaves an emoji and blank line with nothing after alone', () => {
		const r = run(['🚀\n\n']);
		expect(r.emoji).toBeNull();
		expect(r.text).toBe('🚀\n\n');
	});

	it('passes an ordinary reply through unchanged, chunk for chunk', () => {
		const r = run(['Hello', ' there']);
		expect(r.deltas).toEqual([text('Hello'), text(' there')]);
		expect(r.finish).toBe('stop');
	});

	it('only looks at the opening: a later emoji line is prose', () => {
		const r = run(['Okay.\n\n', '❤️\n\n', 'More.']);
		expect(r.emoji).toBeNull();
		expect(r.text).toBe('Okay.\n\n❤️\n\nMore.');
	});

	it('releases held text before a tool call, keeping the order', () => {
		const norm = catchLeadingReaction(
			scripted([
				{ deltas: [text('🔍')] },
				{
					deltas: [{ type: 'tool_call_start', toolCallId: 'c1', toolName: 'web_search', index: 0 }],
					finishReason: 'tool_calls',
				},
			]),
			'call_x',
		);
		const out = [...norm.process(record).deltas, ...norm.process(record).deltas];
		expect(out).toEqual([
			text('🔍'),
			{ type: 'tool_call_start', toolCallId: 'c1', toolName: 'web_search', index: 0 },
		]);
	});

	it('passes reasoning through while the opening is held', () => {
		const norm = catchLeadingReaction(
			scripted([{ deltas: [text('❤️'), { type: 'reasoning', text: 'hm' }, text('\n\nHi')] }]),
			'call_x',
		);
		const out = norm.process(record).deltas;
		expect(out.map((d) => d.type)).toEqual([
			'reasoning',
			'tool_call_start',
			'tool_call_args_delta',
			'text',
		]);
	});

	it('drops a real reaction call made after the typed one', () => {
		const norm = catchLeadingReaction(
			scripted([
				{ deltas: [text('🎉\n\nCongrats!')] },
				{
					deltas: [
						{ type: 'tool_call_start', toolCallId: 'real', toolName: 'react_to_message', index: 0 },
						{
							type: 'tool_call_args_delta',
							toolCallId: 'real',
							index: 0,
							argumentsDelta: '{"emoji":"🥳"}',
						},
					],
					finishReason: 'tool_calls',
				},
			]),
			'call_x',
		);
		const out = [...norm.process(record).deltas, ...norm.process(record).deltas];
		const calls = out.filter((d) => d.type === 'tool_call_start');
		expect(calls).toEqual([
			{ type: 'tool_call_start', toolCallId: 'call_x', toolName: 'react_to_message', index: -1 },
		]);
		expect(out.some((d) => d.type === 'tool_call_args_delta' && d.toolCallId === 'real')).toBe(
			false,
		);
	});

	it('keeps a real non-reaction tool call made after the typed one', () => {
		const norm = catchLeadingReaction(
			scripted([
				{ deltas: [text('🎉\n\nLet me look.')] },
				{
					deltas: [{ type: 'tool_call_start', toolCallId: 'c1', toolName: 'web_search', index: 0 }],
					finishReason: 'tool_calls',
				},
			]),
			'call_x',
		);
		norm.process(record);
		const second = norm.process(record);
		expect(second.deltas).toEqual([
			{ type: 'tool_call_start', toolCallId: 'c1', toolName: 'web_search', index: 0 },
		]);
		expect(second.finishReason).toBe('tool_calls');
	});

	it('releases at flush when the stream ends mid-hold', () => {
		const norm = catchLeadingReaction(scripted([{ deltas: [text('❤️\n')] }]), 'call_x');
		expect(norm.process(record).deltas).toEqual([]);
		expect(norm.flush().deltas).toEqual([text('❤️\n')]);
	});
});

describe('catchLeadingReaction — the call typed out', () => {
	it('turns a typed react_to_message call into a reaction and keeps the reply', () => {
		const r = run(['react_to_message(emoji="😳")\n\nomg...', '\n\nfor real??']);
		expect(r.emoji).toBe('😳');
		expect(r.text).toBe('omg...\n\nfor real??');
		expect(r.finish).toBe('tool_calls');
	});

	it('assembles the call across tokens', () => {
		const r = run(['re', 'act', '_to', '_message', '(emoji', '="', '🥰', '")', '\n', 'stop it']);
		expect(r.emoji).toBe('🥰');
		expect(r.text).toBe('stop it');
	});

	it('waits for the reply to start, so no line break leads it', () => {
		const r = run(['react_to_message(emoji="😳")', '\n', '\n', 'omg']);
		expect(r.emoji).toBe('😳');
		expect(r.text).toBe('omg');
	});

	it('assembles a CRLF split across tokens', () => {
		const r = run(['react_to_message(emoji="😳")\r', '\nomg']);
		expect(r.emoji).toBe('😳');
		expect(r.text).toBe('omg');
	});

	it('takes a single line break, an unnamed argument and single quotes', () => {
		expect(run(["react_to_message('🙈')\nhi"]).emoji).toBe('🙈');
		expect(run(['react_to_message(emoji: "🙈")\nhi']).emoji).toBe('🙈');
	});

	it('takes a reply that is only the call, as a tool turn with no text', () => {
		const r = run(['react_to_message(emoji="😂")']);
		expect(r.emoji).toBe('😂');
		expect(r.text).toBe('');
		expect(r.finish).toBe('tool_calls');
	});

	it('takes a call standing alone before a real tool call, ahead of it', () => {
		const search = {
			type: 'tool_call_start' as const,
			toolCallId: 'c1',
			toolName: 'web_search',
			index: 0,
		};
		const norm = catchLeadingReaction(
			scripted([
				{ deltas: [text('react_to_message(emoji="🤔")')] },
				{ deltas: [search], finishReason: 'tool_calls' },
			]),
			'call_x',
		);
		const out = [...norm.process(record).deltas, ...norm.process(record).deltas];
		expect(out).toEqual([
			{ type: 'tool_call_start', toolCallId: 'call_x', toolName: 'react_to_message', index: -1 },
			{
				type: 'tool_call_args_delta',
				toolCallId: 'call_x',
				index: -1,
				argumentsDelta: '{"emoji":"🤔"}',
			},
			search,
		]);
	});

	it('leaves a call with something that is not an emoji alone', () => {
		const r = run(['react_to_message(emoji="hello")\n\nhi']);
		expect(r.emoji).toBeNull();
		expect(r.text).toBe('react_to_message(emoji="hello")\n\nhi');
	});

	it('leaves prose that only starts like the name alone', () => {
		expect(run(['reacting to that, honestly…']).emoji).toBeNull();
		expect(run(['react_to_message is a tool I have']).text).toBe(
			'react_to_message is a tool I have',
		);
	});

	it('only looks at the opening: a call later in the reply is text', () => {
		const r = run(['hey\n\nreact_to_message(emoji="😂")']);
		expect(r.emoji).toBeNull();
	});
});

describe('syntheticReactionId', () => {
	it('is nine alphanumerics, the strictest tool-call id format an upstream enforces', () => {
		for (let i = 0; i < 50; i++) expect(syntheticReactionId()).toMatch(/^[A-Za-z0-9]{9}$/);
	});
});
