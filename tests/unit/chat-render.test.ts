import { describe, expect, it } from 'vitest';
import {
	appendReasoning,
	appendText,
	buildToolResultsMap,
	computeMergeFlags,
	filterVisibleMessages,
	inFlightToBlocks,
	messageToBlocks,
	pushToolCall,
	updateToolCallArgs,
	updateToolCallResult,
	type InFlightSegment,
	type RenderBlock
} from '$lib/chat-render';
import type { ChatMessage, MessagePart } from '$lib/types/api';

function msg(role: ChatMessage['role'], parts: MessagePart[], over: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: 'm-' + role,
		role,
		parts,
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		createdAt: 0,
		...over
	};
}

const NO_TOOL_RESULTS = new Map<string, { result: string; isError: boolean }>();

// --- messageToBlocks: persisted message → render blocks -----------------

describe('messageToBlocks', () => {
	it('renders a plain user message as one plain-text block', () => {
		const blocks = messageToBlocks(msg('user', [{ type: 'text', text: 'hello' }]), NO_TOOL_RESULTS);
		expect(blocks).toEqual([{ type: 'plain-text', text: 'hello' }]);
	});

	it('renders an assistant with contentHtml as an html block', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'text', text: 'hi' }], { contentHtml: '<p>hi</p>' }),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([{ type: 'html', html: '<p>hi</p>' }]);
	});

	it('falls back to plain-text for an assistant without contentHtml', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'text', text: 'raw' }]),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([{ type: 'plain-text', text: 'raw' }]);
	});

	it('puts reasoning before everything else', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'text', text: 'hi' }], {
				reasoningText: 'thinking...',
				contentHtml: '<p>hi</p>'
			}),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([
			{ type: 'reasoning', text: 'thinking...', open: false },
			{ type: 'html', html: '<p>hi</p>' }
		]);
	});

	it('persisted reasoning is collapsed by default (open=false)', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'text', text: 'hi' }], { reasoningText: 'thoughts' }),
			NO_TOOL_RESULTS
		);
		expect(blocks[0]).toEqual({ type: 'reasoning', text: 'thoughts', open: false });
	});

	it('skips empty text parts (assistant that emitted only tool_calls)', () => {
		const blocks = messageToBlocks(
			msg('assistant', [
				{ type: 'text', text: '' },
				{ type: 'tool_call', toolCallId: 'c1', toolName: 'get_current_time', arguments: '{}' }
			]),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([
			{
				type: 'tool_call',
				toolCallId: 'c1',
				toolName: 'get_current_time',
				arguments: '{}',
				result: undefined,
				isError: undefined,
				status: 'executing'
			}
		]);
	});

	it('renders tool_call as executing when no matching result is in the map', () => {
		const blocks = messageToBlocks(
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'c1', toolName: 'get_current_time', arguments: '{}' }
			]),
			NO_TOOL_RESULTS
		);
		expect(blocks[0]).toMatchObject({ type: 'tool_call', status: 'executing', result: undefined });
	});

	it('renders tool_call as done when matching result exists', () => {
		const results = new Map([
			['c1', { result: '{"iso":"2026-05-26T00:00:00Z"}', isError: false }]
		]);
		const blocks = messageToBlocks(
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'c1', toolName: 'get_current_time', arguments: '{}' }
			]),
			results
		);
		expect(blocks[0]).toMatchObject({
			type: 'tool_call',
			status: 'done',
			result: '{"iso":"2026-05-26T00:00:00Z"}',
			isError: false
		});
	});

	it('renders tool_call as error when isError is set on the result', () => {
		const results = new Map([['c1', { result: 'broken', isError: true }]]);
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}' }]),
			results
		);
		expect(blocks[0]).toMatchObject({ type: 'tool_call', status: 'error', isError: true });
	});

	it('renders multiple tool_calls in part order, each looked up independently', () => {
		const results = new Map([
			['a', { result: 'A', isError: false }],
			['b', { result: 'B', isError: true }]
		]);
		const blocks = messageToBlocks(
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'a', toolName: 't1', arguments: '{}' },
				{ type: 'tool_call', toolCallId: 'b', toolName: 't2', arguments: '{}' }
			]),
			results
		);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({ toolCallId: 'a', status: 'done' });
		expect(blocks[1]).toMatchObject({ toolCallId: 'b', status: 'error' });
	});

	it('uses contentHtml only ONCE (for the first text part)', () => {
		// Schema doesn't actually produce multi-text-part assistant rows
		// today (recorder concatenates), but the helper must not blow up
		// if it ever does. The first text part uses contentHtml; later
		// text parts fall back to plain-text.
		const blocks = messageToBlocks(
			msg(
				'assistant',
				[
					{ type: 'text', text: 'first' },
					{ type: 'text', text: 'second' }
				],
				{ contentHtml: '<p>first</p>' }
			),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([
			{ type: 'html', html: '<p>first</p>' },
			{ type: 'plain-text', text: 'second' }
		]);
	});

	it('renders image parts as image blocks', () => {
		const blocks = messageToBlocks(
			msg('user', [
				{ type: 'text', text: 'look' },
				{ type: 'image', mediaId: 'media-1', alt: 'cat' }
			]),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([
			{ type: 'plain-text', text: 'look' },
			{ type: 'image', mediaId: 'media-1', alt: 'cat' }
		]);
	});

	it('renders video parts as video blocks', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'video', mediaId: 'v1' }]),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([{ type: 'video', mediaId: 'v1' }]);
	});

	it('drops tool_result parts (they fold into matching tool_call blocks via the map)', () => {
		// Defensive: this shape doesn't happen in practice (tool_result
		// lives on role:'tool' messages, not on assistants), but the
		// helper must not render them inline.
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'tool_result', toolCallId: 'x', result: 'leaked' }]),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([]);
	});

	it('preserves natural ordering: text → tool_call (the OpenAI in-iteration shape)', () => {
		const blocks = messageToBlocks(
			msg(
				'assistant',
				[
					{ type: 'text', text: 'let me check' },
					{ type: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}' }
				],
				{ contentHtml: '<p>let me check</p>' }
			),
			NO_TOOL_RESULTS
		);
		expect(blocks).toEqual([
			{ type: 'html', html: '<p>let me check</p>' },
			expect.objectContaining({ type: 'tool_call', toolCallId: 'c1' })
		]);
	});
});

// --- inFlightToBlocks: live streaming state → render blocks -------------

describe('inFlightToBlocks', () => {
	it('returns just a reasoning block when only a reasoning segment is present', () => {
		const segs: InFlightSegment[] = [{ kind: 'reasoning', text: 'thinking...' }];
		expect(inFlightToBlocks(segs)).toEqual([
			{ type: 'reasoning', text: 'thinking...', open: true }
		]);
	});

	it('in-flight reasoning is expanded by default (open=true) — the user is watching the model think', () => {
		const segs: InFlightSegment[] = [{ kind: 'reasoning', text: 'thoughts' }];
		expect(inFlightToBlocks(segs)[0]).toMatchObject({ type: 'reasoning', open: true });
	});

	it('returns empty blocks when nothing has streamed yet', () => {
		expect(inFlightToBlocks([])).toEqual([]);
	});

	it('renders a text segment as html when its html is populated', () => {
		const segs: InFlightSegment[] = [{ kind: 'text', text: 'hello', html: '<p>hello</p>' }];
		expect(inFlightToBlocks(segs)).toEqual([{ type: 'html', html: '<p>hello</p>' }]);
	});

	it('falls back to plain-text when html is not yet rendered', () => {
		const segs: InFlightSegment[] = [{ kind: 'text', text: 'hello', html: '' }];
		expect(inFlightToBlocks(segs)).toEqual([{ type: 'plain-text', text: 'hello' }]);
	});

	it('skips empty text segments entirely', () => {
		const segs: InFlightSegment[] = [{ kind: 'text', text: '', html: '' }];
		expect(inFlightToBlocks(segs)).toEqual([]);
	});

	it('renders a tool_call segment as a tool_call block with its status', () => {
		const segs: InFlightSegment[] = [
			{
				kind: 'tool_call',
				toolCallId: 'c1',
				toolName: 'get_current_time',
				arguments: '{}',
				status: 'executing'
			}
		];
		expect(inFlightToBlocks(segs)).toEqual([
			{
				type: 'tool_call',
				toolCallId: 'c1',
				toolName: 'get_current_time',
				arguments: '{}',
				result: undefined,
				isError: undefined,
				status: 'executing'
			}
		]);
	});

	it('preserves segment arrival order (text → tool → text → tool → text)', () => {
		// This is the multi-tool case the unified renderer was built to
		// handle. The OLD in-flight code with separate text/postText
		// buffers couldn't represent this correctly — all post-tool text
		// would cluster after all the tool blocks.
		const segs: InFlightSegment[] = [
			{ kind: 'text', text: 't0', html: '<p>t0</p>' },
			{ kind: 'tool_call', toolCallId: 'a', toolName: 'x', arguments: '{}', status: 'done' },
			{ kind: 'text', text: 't1', html: '<p>t1</p>' },
			{ kind: 'tool_call', toolCallId: 'b', toolName: 'y', arguments: '{}', status: 'done' },
			{ kind: 'text', text: 't2', html: '<p>t2</p>' }
		];
		const blocks = inFlightToBlocks(segs);
		expect(blocks.map((b) => b.type)).toEqual([
			'html',
			'tool_call',
			'html',
			'tool_call',
			'html'
		]);
		expect((blocks[1] as Extract<RenderBlock, { type: 'tool_call' }>).toolCallId).toBe('a');
		expect((blocks[3] as Extract<RenderBlock, { type: 'tool_call' }>).toolCallId).toBe('b');
	});

	it('renders reasoning at its chronological position, not always at the top', () => {
		// Regression guard: the old code put reasoning ABOVE everything
		// regardless of arrival order, so a model that did
		// text → reasoning → text would render reasoning above all the
		// text. Users complained that history got "reordered after the
		// fact." Now reasoning slots in where it actually streamed.
		const segs: InFlightSegment[] = [
			{ kind: 'text', text: 'pre', html: '<p>pre</p>' },
			{ kind: 'reasoning', text: 'mid-thought' },
			{ kind: 'text', text: 'post', html: '<p>post</p>' }
		];
		const blocks = inFlightToBlocks(segs);
		expect(blocks.map((b) => b.type)).toEqual(['html', 'reasoning', 'html']);
	});

	it('interleaves reasoning across iterations (the multi-iteration tool case)', () => {
		// Iter 0: reasoning → tool_call. Iter 1: reasoning → text.
		const segs: InFlightSegment[] = [
			{ kind: 'reasoning', text: 'should i call the tool?' },
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}', status: 'done' },
			{ kind: 'reasoning', text: 'great, now phrase it' },
			{ kind: 'text', text: 'the answer is 42', html: '<p>the answer is 42</p>' }
		];
		expect(inFlightToBlocks(segs).map((b) => b.type)).toEqual([
			'reasoning',
			'tool_call',
			'reasoning',
			'html'
		]);
	});

	it('propagates tool_call result and isError when done', () => {
		const segs: InFlightSegment[] = [
			{
				kind: 'tool_call',
				toolCallId: 'c1',
				toolName: 'x',
				arguments: '{}',
				status: 'error',
				result: 'oh no',
				isError: true
			}
		];
		const blocks = inFlightToBlocks(segs);
		expect(blocks[0]).toMatchObject({
			type: 'tool_call',
			status: 'error',
			result: 'oh no',
			isError: true
		});
	});
});

// --- in-flight segment mutations ---------------------------------------

describe('appendText', () => {
	it('opens a first text segment when the list is empty', () => {
		expect(appendText([], 'hi')).toEqual([{ kind: 'text', text: 'hi', html: '' }]);
	});

	it('grows the trailing text segment', () => {
		const initial: InFlightSegment[] = [{ kind: 'text', text: 'he', html: '' }];
		expect(appendText(initial, 'llo')).toEqual([{ kind: 'text', text: 'hello', html: '' }]);
	});

	it('preserves the trailing text segment’s cached html', () => {
		const initial: InFlightSegment[] = [{ kind: 'text', text: 'he', html: '<p>he</p>' }];
		// The chat page's rAF effect re-renders html on the next frame;
		// we should not clear it here just because new text arrived
		// (would cause a flash of plain-text mid-render).
		expect(appendText(initial, 'llo')[0]).toMatchObject({ html: '<p>he</p>' });
	});

	it('opens a fresh text segment after a tool_call segment', () => {
		const initial: InFlightSegment[] = [
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}', status: 'done' }
		];
		const next = appendText(initial, 'after-tool');
		expect(next).toHaveLength(2);
		expect(next[1]).toEqual({ kind: 'text', text: 'after-tool', html: '' });
	});

	it('returns a new array (does not mutate input)', () => {
		const initial: InFlightSegment[] = [{ kind: 'text', text: 'a', html: '' }];
		const next = appendText(initial, 'b');
		expect(next).not.toBe(initial);
		const first = initial[0];
		expect(first.kind === 'text' && first.text).toBe('a');
	});
});

describe('appendReasoning', () => {
	it('opens a first reasoning segment when the list is empty', () => {
		expect(appendReasoning([], 'thinking')).toEqual([
			{ kind: 'reasoning', text: 'thinking' }
		]);
	});

	it('grows the trailing reasoning segment', () => {
		const initial: InFlightSegment[] = [{ kind: 'reasoning', text: 'first' }];
		expect(appendReasoning(initial, ' more')).toEqual([
			{ kind: 'reasoning', text: 'first more' }
		]);
	});

	it('opens a fresh reasoning segment after a text segment (interleaved)', () => {
		const initial: InFlightSegment[] = [{ kind: 'text', text: 'hi', html: '' }];
		const next = appendReasoning(initial, 'second thoughts');
		expect(next).toHaveLength(2);
		expect(next[1]).toEqual({ kind: 'reasoning', text: 'second thoughts' });
	});

	it('opens a fresh reasoning segment after a tool_call segment', () => {
		const initial: InFlightSegment[] = [
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}', status: 'done' }
		];
		const next = appendReasoning(initial, 'now what');
		expect(next).toHaveLength(2);
		expect(next[1]).toEqual({ kind: 'reasoning', text: 'now what' });
	});

	it('returns a new array (does not mutate input)', () => {
		const initial: InFlightSegment[] = [{ kind: 'reasoning', text: 'a' }];
		const next = appendReasoning(initial, 'b');
		expect(next).not.toBe(initial);
		const first = initial[0];
		expect(first.kind === 'reasoning' && first.text).toBe('a');
	});
});

describe('pushToolCall', () => {
	it('appends a tool_call segment in executing state', () => {
		const next = pushToolCall([], 'c1', 'get_current_time');
		expect(next).toEqual([
			{
				kind: 'tool_call',
				toolCallId: 'c1',
				toolName: 'get_current_time',
				arguments: '',
				status: 'executing'
			}
		]);
	});

	it('does not collapse adjacent tool_calls (parallel calls stay separate)', () => {
		let segs = pushToolCall([], 'a', 'x');
		segs = pushToolCall(segs, 'b', 'x');
		expect(segs).toHaveLength(2);
		expect((segs[0] as Extract<InFlightSegment, { kind: 'tool_call' }>).toolCallId).toBe('a');
		expect((segs[1] as Extract<InFlightSegment, { kind: 'tool_call' }>).toolCallId).toBe('b');
	});
});

describe('updateToolCallArgs', () => {
	it('appends to the matching tool_call\'s arguments', () => {
		let segs = pushToolCall([], 'c1', 'x');
		segs = updateToolCallArgs(segs, 'c1', '{"a":');
		segs = updateToolCallArgs(segs, 'c1', '1}');
		expect((segs[0] as Extract<InFlightSegment, { kind: 'tool_call' }>).arguments).toBe('{"a":1}');
	});

	it('routes args to the right tool_call when there are multiple', () => {
		let segs = pushToolCall([], 'a', 'x');
		segs = pushToolCall(segs, 'b', 'x');
		segs = updateToolCallArgs(segs, 'b', 'B-args');
		segs = updateToolCallArgs(segs, 'a', 'A-args');
		expect((segs[0] as Extract<InFlightSegment, { kind: 'tool_call' }>).arguments).toBe('A-args');
		expect((segs[1] as Extract<InFlightSegment, { kind: 'tool_call' }>).arguments).toBe('B-args');
	});

	it('no-ops on an unknown toolCallId (defensive against spec-violating upstreams)', () => {
		const initial: InFlightSegment[] = [
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '', status: 'executing' }
		];
		const next = updateToolCallArgs(initial, 'nope', 'orphan');
		expect(next).toEqual(initial);
	});

	it('returns a new array (does not mutate input)', () => {
		const initial: InFlightSegment[] = [
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '', status: 'executing' }
		];
		const next = updateToolCallArgs(initial, 'c1', 'a');
		expect(next).not.toBe(initial);
		expect((initial[0] as Extract<InFlightSegment, { kind: 'tool_call' }>).arguments).toBe('');
	});
});

describe('updateToolCallResult', () => {
	it('flips status to done and records result on success', () => {
		const initial = pushToolCall([], 'c1', 'x');
		const next = updateToolCallResult(initial, 'c1', 'ok', false);
		expect(next[0]).toMatchObject({ status: 'done', result: 'ok', isError: false });
	});

	it('flips status to error when isError=true', () => {
		const initial = pushToolCall([], 'c1', 'x');
		const next = updateToolCallResult(initial, 'c1', 'whoops', true);
		expect(next[0]).toMatchObject({ status: 'error', result: 'whoops', isError: true });
	});

	it('no-ops on an unknown toolCallId', () => {
		const initial: InFlightSegment[] = [
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '', status: 'executing' }
		];
		const next = updateToolCallResult(initial, 'nope', 'orphan', false);
		expect(next).toEqual(initial);
	});

	it('does not change a text segment with the same name', () => {
		// Defensive: text segments don't have toolCallId; the find()
		// would never match. Just confirms the type guard works.
		const initial: InFlightSegment[] = [{ kind: 'text', text: 'hi', html: '' }];
		expect(updateToolCallResult(initial, 'whatever', 'r', false)).toEqual(initial);
	});
});

// --- visibility / tool-result indexing ---------------------------------

describe('filterVisibleMessages', () => {
	it('strips role:tool messages', () => {
		const messages = [
			msg('user', [{ type: 'text', text: 'a' }], { id: 'u' }),
			msg('assistant', [{ type: 'text', text: 'b' }], { id: 'a' }),
			msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'x' }], { id: 't' })
		];
		expect(filterVisibleMessages(messages).map((m) => m.id)).toEqual(['u', 'a']);
	});

	it('returns an empty array when input is empty', () => {
		expect(filterVisibleMessages([])).toEqual([]);
	});

	it('preserves order and references unchanged for visible messages', () => {
		const u = msg('user', [{ type: 'text', text: 'a' }], { id: 'u' });
		const a = msg('assistant', [{ type: 'text', text: 'b' }], { id: 'a' });
		const result = filterVisibleMessages([u, a]);
		expect(result[0]).toBe(u);
		expect(result[1]).toBe(a);
	});
});

describe('buildToolResultsMap', () => {
	it('returns an empty map when there are no tool messages', () => {
		const messages = [msg('user', [{ type: 'text', text: 'hi' }])];
		expect(buildToolResultsMap(messages).size).toBe(0);
	});

	it('indexes a single tool_result by toolCallId', () => {
		const messages = [
			msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'r1' }])
		];
		const map = buildToolResultsMap(messages);
		expect(map.get('c1')).toEqual({ result: 'r1', isError: false });
	});

	it('preserves isError=true when set on the part', () => {
		const messages = [
			msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'oops', isError: true }])
		];
		expect(buildToolResultsMap(messages).get('c1')).toEqual({ result: 'oops', isError: true });
	});

	it('collects results from multiple tool messages', () => {
		const messages = [
			msg('tool', [{ type: 'tool_result', toolCallId: 'a', result: 'A' }], { id: 't1' }),
			msg('tool', [{ type: 'tool_result', toolCallId: 'b', result: 'B' }], { id: 't2' })
		];
		const map = buildToolResultsMap(messages);
		expect(map.get('a')).toEqual({ result: 'A', isError: false });
		expect(map.get('b')).toEqual({ result: 'B', isError: false });
	});

	it('ignores non-tool messages entirely', () => {
		const messages = [
			msg('user', [{ type: 'text', text: 'hi' }]),
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}' }
			])
		];
		expect(buildToolResultsMap(messages).size).toBe(0);
	});
});

// --- bubble-merge flags ------------------------------------------------

describe('computeMergeFlags', () => {
	const u = msg('user', [{ type: 'text', text: 'a' }], { id: 'u' });
	const a1 = msg('assistant', [{ type: 'text', text: 'b' }], { id: 'a1' });
	const a2 = msg('assistant', [{ type: 'text', text: 'c' }], { id: 'a2' });
	const a3 = msg('assistant', [{ type: 'text', text: 'd' }], { id: 'a3' });

	it('no merge on a lone message', () => {
		expect(computeMergeFlags([u], 0, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false
		});
	});

	it('no merge for a user message regardless of neighbors', () => {
		expect(computeMergeFlags([a1, u], 1, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false
		});
	});

	it('first of two adjacent assistants merges WithNext only', () => {
		expect(computeMergeFlags([a1, a2], 0, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: true
		});
	});

	it('second of two adjacent assistants merges WithPrev only', () => {
		expect(computeMergeFlags([a1, a2], 1, null)).toEqual({
			mergeWithPrev: true,
			mergeWithNext: false
		});
	});

	it('middle assistant in a 3-row group merges with both sides', () => {
		expect(computeMergeFlags([a1, a2, a3], 1, null)).toEqual({
			mergeWithPrev: true,
			mergeWithNext: true
		});
	});

	it('does not merge assistant with adjacent user message', () => {
		expect(computeMergeFlags([u, a1, u], 1, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false
		});
	});

	it('editing a message breaks the merge with its neighbors', () => {
		// The inline editor replaces the article entirely with an
		// amber-bordered edit form. It would look broken visually fused
		// with adjacent bubbles.
		expect(computeMergeFlags([a1, a2, a3], 1, 'a2')).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false
		});
		expect(computeMergeFlags([a1, a2, a3], 0, 'a2')).toMatchObject({
			mergeWithNext: false
		});
		expect(computeMergeFlags([a1, a2, a3], 2, 'a2')).toMatchObject({
			mergeWithPrev: false
		});
	});

	it('handles out-of-range index gracefully', () => {
		expect(computeMergeFlags([a1], 5, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false
		});
	});
});
