import { describe, expect, it } from 'vitest';
import {
	appendReasoning,
	appendText,
	assistantLabelForMessage,
	buildToolResultsMap,
	computeMergeFlags,
	extractCodeArg,
	filterVisibleMessages,
	inFlightToBlocks,
	markToolCallPendingApproval,
	messageToBlocks,
	parseSkillToolDisplay,
	pushToolCall,
	updateToolCallArgs,
	updateToolCallResult,
	type InFlightSegment,
	type RenderBlock,
	type ToolResultEntry,
} from '$lib/chat-render';
import type { ChatMessage, MessagePart } from '$lib/types/api';

function msg(
	role: ChatMessage['role'],
	parts: MessagePart[],
	over: Partial<ChatMessage> = {},
): ChatMessage {
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
		genMs: null,
		createdAt: 0,
		...over,
	};
}

const NO_TOOL_RESULTS = new Map<string, ToolResultEntry>();

// --- messageToBlocks: persisted message → render blocks -----------------

describe('messageToBlocks', () => {
	it('renders a plain user message as one plain-text block', () => {
		const blocks = messageToBlocks(msg('user', [{ type: 'text', text: 'hello' }]), NO_TOOL_RESULTS);
		expect(blocks).toEqual([{ type: 'plain-text', text: 'hello' }]);
	});

	it('renders an assistant with contentHtml as an html block', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'text', text: 'hi' }], { contentHtml: '<p>hi</p>' }),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([{ type: 'html', html: '<p>hi</p>' }]);
	});

	it('falls back to plain-text for an assistant without contentHtml', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'text', text: 'raw' }]),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([{ type: 'plain-text', text: 'raw' }]);
	});

	it('puts reasoning before everything else', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'text', text: 'hi' }], {
				reasoningText: 'thinking...',
				contentHtml: '<p>hi</p>',
			}),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([
			{ type: 'reasoning', text: 'thinking...', open: false },
			{ type: 'html', html: '<p>hi</p>' },
		]);
	});

	it('persisted reasoning is collapsed by default (open=false)', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'text', text: 'hi' }], { reasoningText: 'thoughts' }),
			NO_TOOL_RESULTS,
		);
		expect(blocks[0]).toEqual({ type: 'reasoning', text: 'thoughts', open: false });
	});

	it('skips empty text parts (assistant that emitted only tool_calls)', () => {
		const blocks = messageToBlocks(
			msg('assistant', [
				{ type: 'text', text: '' },
				{ type: 'tool_call', toolCallId: 'c1', toolName: 'get_current_time', arguments: '{}' },
			]),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([
			{
				type: 'tool_call',
				toolCallId: 'c1',
				toolName: 'get_current_time',
				arguments: '{}',
				result: undefined,
				isError: undefined,
				status: 'executing',
			},
		]);
	});

	it('renders tool_call as executing when no matching result is in the map', () => {
		const blocks = messageToBlocks(
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'c1', toolName: 'get_current_time', arguments: '{}' },
			]),
			NO_TOOL_RESULTS,
		);
		expect(blocks[0]).toMatchObject({ type: 'tool_call', status: 'executing', result: undefined });
	});

	it('renders tool_call as done when matching result exists', () => {
		const results = new Map([['c1', { result: '{"iso":"2026-05-26T00:00:00Z"}', isError: false }]]);
		const blocks = messageToBlocks(
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'c1', toolName: 'get_current_time', arguments: '{}' },
			]),
			results,
		);
		expect(blocks[0]).toMatchObject({
			type: 'tool_call',
			status: 'done',
			result: '{"iso":"2026-05-26T00:00:00Z"}',
			isError: false,
		});
	});

	it('renders tool_call as error when isError is set on the result', () => {
		const results = new Map([['c1', { result: 'broken', isError: true }]]);
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}' }]),
			results,
		);
		expect(blocks[0]).toMatchObject({ type: 'tool_call', status: 'error', isError: true });
	});

	it('renders multiple tool_calls in part order, each looked up independently', () => {
		const results = new Map([
			['a', { result: 'A', isError: false }],
			['b', { result: 'B', isError: true }],
		]);
		const blocks = messageToBlocks(
			msg('assistant', [
				{ type: 'tool_call', toolCallId: 'a', toolName: 't1', arguments: '{}' },
				{ type: 'tool_call', toolCallId: 'b', toolName: 't2', arguments: '{}' },
			]),
			results,
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
					{ type: 'text', text: 'second' },
				],
				{ contentHtml: '<p>first</p>' },
			),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([
			{ type: 'html', html: '<p>first</p>' },
			{ type: 'plain-text', text: 'second' },
		]);
	});

	it('renders image parts as image blocks', () => {
		const blocks = messageToBlocks(
			msg('user', [
				{ type: 'text', text: 'look' },
				{ type: 'image', mediaId: 'media-1', alt: 'cat' },
			]),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([
			{ type: 'plain-text', text: 'look' },
			{ type: 'image', mediaId: 'media-1', alt: 'cat' },
		]);
	});

	it('renders video parts as video blocks', () => {
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'video', mediaId: 'v1' }]),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([{ type: 'video', mediaId: 'v1' }]);
	});

	it('drops tool_result parts (they fold into matching tool_call blocks via the map)', () => {
		// Defensive: this shape doesn't happen in practice (tool_result
		// lives on role:'tool' messages, not on assistants), but the
		// helper must not render them inline.
		const blocks = messageToBlocks(
			msg('assistant', [{ type: 'tool_result', toolCallId: 'x', result: 'leaked' }]),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([]);
	});

	it('preserves natural ordering: text → tool_call (the OpenAI in-iteration shape)', () => {
		const blocks = messageToBlocks(
			msg(
				'assistant',
				[
					{ type: 'text', text: 'let me check' },
					{ type: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}' },
				],
				{ contentHtml: '<p>let me check</p>' },
			),
			NO_TOOL_RESULTS,
		);
		expect(blocks).toEqual([
			{ type: 'html', html: '<p>let me check</p>' },
			expect.objectContaining({ type: 'tool_call', toolCallId: 'c1' }),
		]);
	});
});

// --- inFlightToBlocks: live streaming state → render blocks -------------

describe('inFlightToBlocks', () => {
	it('returns just a reasoning block when only a reasoning segment is present', () => {
		const segs: InFlightSegment[] = [{ kind: 'reasoning', text: 'thinking...' }];
		expect(inFlightToBlocks(segs)).toEqual([
			{ type: 'reasoning', text: 'thinking...', open: true },
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
				status: 'executing',
			},
		];
		expect(inFlightToBlocks(segs)).toEqual([
			{
				type: 'tool_call',
				toolCallId: 'c1',
				toolName: 'get_current_time',
				arguments: '{}',
				result: undefined,
				isError: undefined,
				status: 'executing',
			},
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
			{ kind: 'text', text: 't2', html: '<p>t2</p>' },
		];
		const blocks = inFlightToBlocks(segs);
		expect(blocks.map((b) => b.type)).toEqual(['html', 'tool_call', 'html', 'tool_call', 'html']);
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
			{ kind: 'text', text: 'post', html: '<p>post</p>' },
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
			{ kind: 'text', text: 'the answer is 42', html: '<p>the answer is 42</p>' },
		];
		expect(inFlightToBlocks(segs).map((b) => b.type)).toEqual([
			'reasoning',
			'tool_call',
			'reasoning',
			'html',
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
				isError: true,
			},
		];
		const blocks = inFlightToBlocks(segs);
		expect(blocks[0]).toMatchObject({
			type: 'tool_call',
			status: 'error',
			result: 'oh no',
			isError: true,
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
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}', status: 'done' },
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
		expect(appendReasoning([], 'thinking')).toEqual([{ kind: 'reasoning', text: 'thinking' }]);
	});

	it('grows the trailing reasoning segment', () => {
		const initial: InFlightSegment[] = [{ kind: 'reasoning', text: 'first' }];
		expect(appendReasoning(initial, ' more')).toEqual([{ kind: 'reasoning', text: 'first more' }]);
	});

	it('opens a fresh reasoning segment after a text segment (interleaved)', () => {
		const initial: InFlightSegment[] = [{ kind: 'text', text: 'hi', html: '' }];
		const next = appendReasoning(initial, 'second thoughts');
		expect(next).toHaveLength(2);
		expect(next[1]).toEqual({ kind: 'reasoning', text: 'second thoughts' });
	});

	it('opens a fresh reasoning segment after a tool_call segment', () => {
		const initial: InFlightSegment[] = [
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}', status: 'done' },
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
				status: 'executing',
			},
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
	it("appends to the matching tool_call's arguments", () => {
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
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '', status: 'executing' },
		];
		const next = updateToolCallArgs(initial, 'nope', 'orphan');
		expect(next).toEqual(initial);
	});

	it('returns a new array (does not mutate input)', () => {
		const initial: InFlightSegment[] = [
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '', status: 'executing' },
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
			{ kind: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '', status: 'executing' },
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
			msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'x' }], { id: 't' }),
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
		const messages = [msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'r1' }])];
		const map = buildToolResultsMap(messages);
		expect(map.get('c1')).toEqual({ result: 'r1', isError: false });
	});

	it('preserves isError=true when set on the part', () => {
		const messages = [
			msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'oops', isError: true }]),
		];
		expect(buildToolResultsMap(messages).get('c1')).toEqual({ result: 'oops', isError: true });
	});

	it('collects results from multiple tool messages', () => {
		const messages = [
			msg('tool', [{ type: 'tool_result', toolCallId: 'a', result: 'A' }], { id: 't1' }),
			msg('tool', [{ type: 'tool_result', toolCallId: 'b', result: 'B' }], { id: 't2' }),
		];
		const map = buildToolResultsMap(messages);
		expect(map.get('a')).toEqual({ result: 'A', isError: false });
		expect(map.get('b')).toEqual({ result: 'B', isError: false });
	});

	it('ignores non-tool messages entirely', () => {
		const messages = [
			msg('user', [{ type: 'text', text: 'hi' }]),
			msg('assistant', [{ type: 'tool_call', toolCallId: 'c1', toolName: 'x', arguments: '{}' }]),
		];
		expect(buildToolResultsMap(messages).size).toBe(0);
	});

	it('surfaces the pending_approval status on the indexed entry', () => {
		// MCP tools waiting on the user's approval prompt persist with
		// `status: 'pending_approval'` + an empty result; the in-line
		// tool block reads that off the map to render Allow / Always /
		// Reject buttons.
		const messages = [
			msg('tool', [
				{
					type: 'tool_result',
					toolCallId: 'c1',
					result: '',
					status: 'pending_approval',
				},
			]),
		];
		expect(buildToolResultsMap(messages).get('c1')).toEqual({
			result: '',
			isError: false,
			status: 'pending_approval',
		});
	});

	it('omits the status field on completed rows (defensive read at consumers)', () => {
		// Persisted shape stays byte-identical with the pre-approval
		// schema for tools that ran inline (built-ins + trusted MCP) —
		// `status` is absent rather than 'completed'.
		const messages = [msg('tool', [{ type: 'tool_result', toolCallId: 'c1', result: 'done' }])];
		const entry = buildToolResultsMap(messages).get('c1');
		expect(entry).toEqual({ result: 'done', isError: false });
		expect((entry as { status?: string }).status).toBeUndefined();
	});
});

describe('messageToBlocks tool_call → pending_approval mapping', () => {
	it("flips a tool_call block's status to 'pending_approval' when its result row says so", () => {
		// The inline ToolCallBlock renders the Allow / Always / Reject
		// buttons when status === 'pending_approval', so the mapping
		// from the persisted tool_result.status to the RenderBlock
		// status is the load-bearing link for the approval UI.
		const assistant = msg(
			'assistant',
			[
				{
					type: 'tool_call',
					toolCallId: 'call_x',
					toolName: 'mcp__fs__read_file',
					arguments: '{"path":"/tmp"}',
				},
			],
			{ id: 'a1' },
		);
		const results = new Map<string, ToolResultEntry>([
			['call_x', { result: '', isError: false, status: 'pending_approval' }],
		]);
		const blocks = messageToBlocks(assistant, results);
		const toolBlock = blocks.find((b) => b.type === 'tool_call');
		expect(toolBlock).toMatchObject({
			type: 'tool_call',
			toolCallId: 'call_x',
			status: 'pending_approval',
		});
	});

	it('renders as executing when there is no tool_result row at all', () => {
		// The model just emitted the tool_call but the relay hasn't
		// persisted the matching role:'tool' row yet — the inline
		// block stays in the in-flight 'executing' spinner state.
		const assistant = msg(
			'assistant',
			[{ type: 'tool_call', toolCallId: 'call_y', toolName: 'clock', arguments: '{}' }],
			{ id: 'a1' },
		);
		const blocks = messageToBlocks(assistant, NO_TOOL_RESULTS);
		const toolBlock = blocks.find((b) => b.type === 'tool_call');
		expect(toolBlock).toMatchObject({ status: 'executing' });
	});
});

describe('markToolCallPendingApproval', () => {
	const baseSegment = {
		kind: 'tool_call' as const,
		toolCallId: 'call_x',
		toolName: 'mcp__fs__read_file',
		arguments: '{"path":"/tmp"}',
		status: 'executing' as const,
	};

	it("flips an existing segment's status without losing already-streamed arguments", () => {
		// `tool_call_args_delta` events stream the args string in
		// chunks before the relay decides whether the tool needs
		// approval; the helper must preserve whatever the segment
		// already buffered if the SSE event's args field is empty.
		const segments: InFlightSegment[] = [baseSegment];
		const next = markToolCallPendingApproval(segments, 'call_x', 'mcp__fs__read_file', '');
		expect(next[0]).toMatchObject({
			kind: 'tool_call',
			toolCallId: 'call_x',
			status: 'pending_approval',
			arguments: '{"path":"/tmp"}',
		});
	});

	it('prefers the SSE event args when non-empty (server has the canonical string)', () => {
		const segments: InFlightSegment[] = [{ ...baseSegment, arguments: '{"path":"/old"}' }];
		const next = markToolCallPendingApproval(
			segments,
			'call_x',
			'mcp__fs__read_file',
			'{"path":"/new"}',
		);
		expect(next[0]).toMatchObject({
			status: 'pending_approval',
			arguments: '{"path":"/new"}',
		});
	});

	it('synthesizes a new segment when no matching tool_call_start was seen', () => {
		// Defensive — if a `tool_pending_approval` event somehow
		// lands without a prior `tool_call_start`, the helper
		// appends a synthetic segment so the UI renders the prompt
		// instead of silently dropping it.
		const segments: InFlightSegment[] = [];
		const next = markToolCallPendingApproval(
			segments,
			'call_x',
			'mcp__fs__read_file',
			'{"path":"/tmp"}',
		);
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({
			kind: 'tool_call',
			toolCallId: 'call_x',
			toolName: 'mcp__fs__read_file',
			arguments: '{"path":"/tmp"}',
			status: 'pending_approval',
		});
	});

	it('returns the original array when the toolCallId points at a non-tool_call segment', () => {
		// Should be impossible — toolCallIds don't collide across
		// segment kinds — but defend against it by leaving the
		// segments array untouched rather than rewriting the type.
		const segments: InFlightSegment[] = [{ kind: 'text', text: 'hi', html: '' }];
		const next = markToolCallPendingApproval(segments, 'call_x', 'x', '');
		// Synthesizes a new segment because no matching tool_call exists.
		expect(next).toHaveLength(2);
		expect(next[0]).toEqual(segments[0]);
		expect(next[1]).toMatchObject({ status: 'pending_approval' });
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
			mergeWithNext: false,
		});
	});

	it('no merge for a user message regardless of neighbors', () => {
		expect(computeMergeFlags([a1, u], 1, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false,
		});
	});

	it('first of two adjacent assistants merges WithNext only', () => {
		expect(computeMergeFlags([a1, a2], 0, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: true,
		});
	});

	it('second of two adjacent assistants merges WithPrev only', () => {
		expect(computeMergeFlags([a1, a2], 1, null)).toEqual({
			mergeWithPrev: true,
			mergeWithNext: false,
		});
	});

	it('middle assistant in a 3-row group merges with both sides', () => {
		expect(computeMergeFlags([a1, a2, a3], 1, null)).toEqual({
			mergeWithPrev: true,
			mergeWithNext: true,
		});
	});

	it('does not merge assistant with adjacent user message', () => {
		expect(computeMergeFlags([u, a1, u], 1, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false,
		});
	});

	it('editing a message breaks the merge with its neighbors', () => {
		// The inline editor replaces the article entirely with an
		// amber-bordered edit form. It would look broken visually fused
		// with adjacent bubbles.
		expect(computeMergeFlags([a1, a2, a3], 1, 'a2')).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false,
		});
		expect(computeMergeFlags([a1, a2, a3], 0, 'a2')).toMatchObject({
			mergeWithNext: false,
		});
		expect(computeMergeFlags([a1, a2, a3], 2, 'a2')).toMatchObject({
			mergeWithPrev: false,
		});
	});

	it('handles out-of-range index gracefully', () => {
		expect(computeMergeFlags([a1], 5, null)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false,
		});
	});

	it('mergeIntoInFlight forces mergeWithNext on the trailing assistant', () => {
		// Approval-resume case: the prior turn halted on a tool call so
		// the persisted view ends on an assistant row, then the live
		// in-flight bubble streams the next iteration's content below.
		// Without this flag the two visually look like separate bubbles
		// until invalidate, then "snap" together.
		expect(computeMergeFlags([u, a1], 1, null, true)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: true,
		});
	});

	it('mergeIntoInFlight does not affect non-trailing assistants', () => {
		// Only the LAST visible message gets the in-flight merge — the
		// in-flight bubble fuses with that one, not the one before it.
		expect(computeMergeFlags([a1, a2], 0, null, true)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: true, // still merges with a2, not because of in-flight
		});
		// The trailing a2 also gets the in-flight forced merge — it
		// already merges with a1 via the persisted rule + with the live
		// bubble below.
		expect(computeMergeFlags([a1, a2], 1, null, true)).toEqual({
			mergeWithPrev: true,
			mergeWithNext: true,
		});
	});

	it('mergeIntoInFlight has no effect when the trailing message is a user row', () => {
		// Normal send case: user message at the end + in-flight bubble
		// for the new assistant response. They render as separate
		// bubbles (the user bubble is right-aligned, the assistant
		// in-flight is left-aligned) — merge logic shouldn't fuse
		// across roles.
		expect(computeMergeFlags([a1, u], 1, null, true)).toEqual({
			mergeWithPrev: false,
			mergeWithNext: false,
		});
	});
});

describe('extractCodeArg — streaming-tolerant partial JSON extraction', () => {
	it('returns null for unknown tools', () => {
		expect(extractCodeArg('clock', '{"code":"print(1)"}')).toBeNull();
		expect(extractCodeArg('fetch_url', '{"code":"anything"}')).toBeNull();
	});

	it('returns null for empty args', () => {
		expect(extractCodeArg('run_python', '')).toBeNull();
	});

	it('extracts the code field + language from a complete JSON envelope', () => {
		expect(extractCodeArg('run_python', '{"code":"print(1+1)"}')).toEqual({
			code: 'print(1+1)',
			language: 'python',
		});
	});

	it('decodes standard escape sequences in the strict-parse path', () => {
		// `\n` in the JSON should decode to a real newline; the same source
		// rendered as JSON pretty-print would have shown `\n` literal.
		expect(
			extractCodeArg('run_python', '{"code":"import pandas as pd\\nimport numpy as np"}')?.code,
		).toBe('import pandas as pd\nimport numpy as np');
	});

	it('handles mid-stream args with no closing brace yet', () => {
		// Common case during streaming: the model has emitted the code
		// field but the closing `"` + `}` haven't arrived. We should
		// still show what we have.
		expect(extractCodeArg('run_python', '{"code":"import pandas')?.code).toBe('import pandas');
	});

	it('handles mid-stream args with no closing string quote yet', () => {
		// Similar — even shorter, mid-string. The string fragment should
		// keep growing as more tokens arrive.
		expect(extractCodeArg('run_python', '{"code":"def fib(n):\\n    if n')?.code).toBe(
			'def fib(n):\n    if n',
		);
	});

	it('returns null before the code field has started streaming', () => {
		// Edge: model emitted just the opening brace + a different field
		// before code. Nothing to render yet.
		expect(extractCodeArg('run_python', '{')).toBeNull();
		expect(extractCodeArg('run_python', '{"other":"x"')).toBeNull();
	});

	it('drops an incomplete escape sequence at the end of the buffer', () => {
		// `\` at end-of-string would be an incomplete escape — the
		// extractor stops at it rather than decoding garbage.
		expect(extractCodeArg('run_python', '{"code":"a\\')?.code).toBe('a');
	});

	it('decodes \\uXXXX escapes when complete; stops at incomplete ones', () => {
		expect(extractCodeArg('run_python', '{"code":"\\u00e9clair"}')?.code).toBe('éclair');
		// Incomplete unicode escape (only 2 hex digits arrived) — stop.
		expect(extractCodeArg('run_python', '{"code":"x\\u00')?.code).toBe('x');
	});

	it('handles whitespace between the colon and the value', () => {
		// Models occasionally insert spaces. Strict JSON tolerates this
		// at end-of-message; the partial path needs to too.
		expect(extractCodeArg('run_python', '{"code" :   "ok')?.code).toBe('ok');
	});

	it('handles escaped quotes inside the code', () => {
		expect(extractCodeArg('run_python', '{"code":"print(\\"hi\\")"}')?.code).toBe('print("hi")');
	});

	it('strict path treats empty-string code as absent', () => {
		// A complete envelope with empty code isn't useful to render —
		// returning null lets ToolCallBlock fall through to the JSON
		// view, which says "{ \"code\": \"\" }" and at least makes the
		// empty intent visible.
		expect(extractCodeArg('run_python', '{"code":""}')).toBeNull();
	});

	it('returns null when the strict parse succeeds but the field is the wrong type', () => {
		// Malformed model output — the field exists but isn't a string.
		// Don't crash; fall through to the JSON view.
		expect(extractCodeArg('run_python', '{"code":42}')).toBeNull();
		expect(extractCodeArg('run_python', '{"code":null}')).toBeNull();
	});
});

describe('assistantLabelForMessage', () => {
	const models = [
		{ id: 'bridge::a', displayName: 'Model A' },
		{ id: 'bridge::b', displayName: 'Model B' },
	] as unknown as Parameters<typeof assistantLabelForMessage>[3];

	const asst = (modelUsed: string | null) =>
		({ role: 'assistant', modelUsed }) as Parameters<typeof assistantLabelForMessage>[0];

	it('uses the conversation label for the conversation default model', () => {
		// This is the path that preserves custom-preset naming: the preset's
		// modelUsed equals the stored base model id.
		expect(assistantLabelForMessage(asst('bridge::a'), 'bridge::a', 'My Preset', models)).toBe(
			'My Preset',
		);
	});

	it('labels a kept fan-out branch by its own model, not the conversation default', () => {
		// Conversation default is bridge::a; this sibling was model B.
		expect(assistantLabelForMessage(asst('bridge::b'), 'bridge::a', 'Model A', models)).toBe(
			'Model B',
		);
	});

	it('falls back to the conversation label when modelUsed is absent', () => {
		expect(assistantLabelForMessage(asst(null), 'bridge::a', 'Model A', models)).toBe('Model A');
	});

	it('uses the conversation label for non-assistant rows', () => {
		const user = { role: 'user', modelUsed: 'bridge::b' } as Parameters<
			typeof assistantLabelForMessage
		>[0];
		expect(assistantLabelForMessage(user, 'bridge::a', 'You-conv', models)).toBe('You-conv');
	});

	it('strips endpoint + owner prefixes for an unknown (removed) model', () => {
		expect(
			assistantLabelForMessage(
				asst('gone::meta-llama/Llama-3-70b'),
				'bridge::a',
				'Model A',
				models,
			),
		).toBe('Llama-3-70b');
	});
});

describe('parseSkillToolDisplay', () => {
	const activateResult =
		'<skill_content name="review">\n\n# Review\n\nReview the code.\n\n<skill_resources>\nFiles bundled with this skill:\n- references/api.md\n- scripts/run.py\n</skill_resources>\n\n</skill_content>';

	it('returns null for non-skill tools', () => {
		expect(parseSkillToolDisplay('run_python', '{"code":"x"}', 'out', false)).toBeNull();
		expect(parseSkillToolDisplay('web_search', '{}', '', false)).toBeNull();
	});

	it('parses an activate_skill call: name + unwrapped markdown body + resources', () => {
		const d = parseSkillToolDisplay('activate_skill', '{"name":"review"}', activateResult, false)!;
		expect(d.kind).toBe('activate');
		expect(d.skillName).toBe('review');
		expect(d.path).toBeNull();
		expect(d.body).toBe('# Review\n\nReview the code.');
		expect(d.body).not.toContain('<skill_content');
		expect(d.body).not.toContain('<skill_resources');
		expect(d.resources).toEqual(['references/api.md', 'scripts/run.py']);
		expect(d.isError).toBe(false);
	});

	it('parses a read_skill_file call: name + path + unwrapped file text', () => {
		const result =
			'<skill_file name="review" path="references/api.md">\n# API\n\nstuff\n</skill_file>';
		const d = parseSkillToolDisplay(
			'read_skill_file',
			'{"name":"review","path":"references/api.md"}',
			result,
			false,
		)!;
		expect(d.kind).toBe('read_file');
		expect(d.skillName).toBe('review');
		expect(d.path).toBe('references/api.md');
		expect(d.body).toBe('# API\n\nstuff');
	});

	it('has a null body while still executing (no result yet)', () => {
		const d = parseSkillToolDisplay('activate_skill', '{"name":"review"}', undefined, false)!;
		expect(d.skillName).toBe('review');
		expect(d.body).toBeNull();
	});

	it('surfaces the error message for a failed call', () => {
		const d = parseSkillToolDisplay(
			'activate_skill',
			'{"name":"ghost"}',
			'{"error":"No enabled skill named \\"ghost\\"."}',
			true,
		)!;
		expect(d.isError).toBe(true);
		expect(d.body).toBe('No enabled skill named "ghost".');
	});

	it('extracts the name from partial mid-stream args', () => {
		// Args still arriving — no closing brace yet.
		const d = parseSkillToolDisplay('activate_skill', '{"name":"review', undefined, false)!;
		expect(d.skillName).toBe('review');
	});
});
