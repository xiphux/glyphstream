/** Tests for the SSE event dispatcher used by the chat page. */

import { describe, expect, it, vi } from 'vitest';
import { consumeChatStream } from '$lib/consume-chat-stream';
import type { ChatMessage, StreamEvent } from '$lib/types/api';

const TEXT_ENCODER = new TextEncoder();

/** Wrap an array of StreamEvent objects into a fake SSE body that the
 *  readSSE helper can consume. Each event is encoded as a standalone
 *  `event:` + `data:` block, just like the relay emits. */
function streamFromEvents(events: StreamEvent[]): ReadableStream<Uint8Array> {
	const chunks = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(TEXT_ENCODER.encode(chunk));
			controller.close();
		},
	});
}

/** Wrap a raw string body (lets us inject malformed SSE for the
 *  parse-tolerance test). */
function streamFromRaw(raw: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(TEXT_ENCODER.encode(raw));
			controller.close();
		},
	});
}

const USER_MSG: ChatMessage = {
	id: 'user-1',
	role: 'user',
	parts: [{ type: 'text', text: 'hello' }],
	contentHtml: null,
	reasoningText: null,
	finishReason: null,
	modelUsed: null,
	tokensIn: null,
	tokensOut: null,
	createdAt: 1,
	parentMessageId: null,
};

const ASSISTANT_MSG: ChatMessage = {
	id: 'asst-1',
	role: 'assistant',
	parts: [{ type: 'text', text: 'hi back' }],
	contentHtml: null,
	reasoningText: null,
	finishReason: null,
	modelUsed: null,
	tokensIn: null,
	tokensOut: null,
	createdAt: 2,
	parentMessageId: 'user-1',
};

describe('consumeChatStream', () => {
	it('dispatches start → text → done in order', async () => {
		const calls: string[] = [];
		const body = streamFromEvents([
			{ type: 'start', userMessage: USER_MSG, assistantMessageId: 'asst-1' },
			{ type: 'text', chunk: 'hi ' },
			{ type: 'text', chunk: 'back' },
			{ type: 'done', assistantMessage: ASSISTANT_MSG },
		]);

		const { sawToolCalls } = await consumeChatStream(body, {
			onStart: (m) => {
				calls.push(`start:${m.id}`);
			},
			onText: (c) => {
				calls.push(`text:${c}`);
			},
			onDone: ({ assistantMessage, sawToolCalls }) => {
				calls.push(`done:${assistantMessage.id}:${sawToolCalls}`);
			},
		});

		expect(calls).toEqual(['start:user-1', 'text:hi ', 'text:back', 'done:asst-1:false']);
		expect(sawToolCalls).toBe(false);
	});

	it('flips sawToolCalls when a tool_call_start arrives, and threads it into onDone', async () => {
		const onDone = vi.fn();
		const body = streamFromEvents([
			{ type: 'tool_call_start', toolCallId: 't1', toolName: 'search' },
			{ type: 'tool_call_result', toolCallId: 't1', result: 'ok', isError: false },
			{ type: 'done', assistantMessage: ASSISTANT_MSG },
		]);

		const result = await consumeChatStream(body, { onDone });

		expect(result.sawToolCalls).toBe(true);
		expect(onDone).toHaveBeenCalledWith({
			assistantMessage: ASSISTANT_MSG,
			sawToolCalls: true,
		});
	});

	it('flips sawToolCalls on tool_pending_approval too', async () => {
		const body = streamFromEvents([
			{
				type: 'tool_pending_approval',
				toolCallId: 't2',
				toolName: 'mcp:fs.read',
				args: '{"path":"/etc/passwd"}',
				displayLabel: 'Read file',
				category: 'mcp:fs',
			},
		]);

		const { sawToolCalls } = await consumeChatStream(body, {});
		expect(sawToolCalls).toBe(true);
	});

	it('routes each event type to its matching callback', async () => {
		const cb = {
			onStart: vi.fn(),
			onText: vi.fn(),
			onReasoning: vi.fn(),
			onToolCallStart: vi.fn(),
			onToolCallArgsDelta: vi.fn(),
			onToolCallExecuting: vi.fn(),
			onToolCallResult: vi.fn(),
			onToolPendingApproval: vi.fn(),
			onProgress: vi.fn(),
			onTitle: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const body = streamFromEvents([
			{ type: 'start', userMessage: USER_MSG, assistantMessageId: 'asst-1' },
			{ type: 'text', chunk: 'hi' },
			{ type: 'reasoning', chunk: 'because' },
			{ type: 'tool_call_start', toolCallId: 't1', toolName: 'search' },
			{ type: 'tool_call_args_delta', toolCallId: 't1', argumentsDelta: '{"q' },
			{ type: 'tool_call_executing', toolCallId: 't1' },
			{ type: 'tool_call_result', toolCallId: 't1', result: 'ok', isError: false },
			{
				type: 'tool_pending_approval',
				toolCallId: 't2',
				toolName: 'mcp:fs.read',
				args: '{}',
			},
			{ type: 'progress', percent: 50, status: 'rendering' },
			{ type: 'title', title: 'A Title' },
			{ type: 'error', message: 'boom' },
			{ type: 'done', assistantMessage: ASSISTANT_MSG },
		]);

		await consumeChatStream(body, cb);

		expect(cb.onStart).toHaveBeenCalledWith(USER_MSG);
		expect(cb.onText).toHaveBeenCalledWith('hi');
		expect(cb.onReasoning).toHaveBeenCalledWith('because');
		expect(cb.onToolCallStart).toHaveBeenCalledWith('t1', 'search');
		expect(cb.onToolCallArgsDelta).toHaveBeenCalledWith('t1', '{"q');
		expect(cb.onToolCallExecuting).toHaveBeenCalledWith('t1');
		expect(cb.onToolCallResult).toHaveBeenCalledWith('t1', 'ok', false);
		expect(cb.onToolPendingApproval).toHaveBeenCalledWith(
			't2',
			'mcp:fs.read',
			'{}',
			undefined,
			undefined,
		);
		expect(cb.onProgress).toHaveBeenCalledWith(50, 'rendering');
		expect(cb.onTitle).toHaveBeenCalledWith('A Title');
		expect(cb.onError).toHaveBeenCalledWith('boom');
		expect(cb.onDone).toHaveBeenCalledTimes(1);
	});

	it('stops dispatching once shouldContinue returns false', async () => {
		const onText = vi.fn();
		const onDone = vi.fn();
		let calls = 0;
		const body = streamFromEvents([
			{ type: 'text', chunk: 'a' },
			{ type: 'text', chunk: 'b' },
			{ type: 'done', assistantMessage: ASSISTANT_MSG },
		]);

		await consumeChatStream(body, {
			shouldContinue: () => ++calls <= 1,
			onText,
			onDone,
		});

		// First check: continue (process 'a'). Second check: stop.
		expect(onText).toHaveBeenCalledTimes(1);
		expect(onText).toHaveBeenCalledWith('a');
		expect(onDone).not.toHaveBeenCalled();
	});

	it('skips malformed JSON data lines without aborting the stream', async () => {
		// First block has invalid JSON; second block is a well-formed text event.
		const raw =
			'event: text\ndata: not-json\n\n' +
			'event: text\ndata: {"type":"text","chunk":"recovered"}\n\n';
		const onText = vi.fn();

		await consumeChatStream(streamFromRaw(raw), { onText });

		expect(onText).toHaveBeenCalledTimes(1);
		expect(onText).toHaveBeenCalledWith('recovered');
	});

	it('awaits async onStart before processing the next event', async () => {
		const order: string[] = [];
		const body = streamFromEvents([
			{ type: 'start', userMessage: USER_MSG, assistantMessageId: 'asst-1' },
			{ type: 'text', chunk: 'after' },
		]);

		await consumeChatStream(body, {
			onStart: async () => {
				await Promise.resolve();
				order.push('start-resolved');
			},
			onText: (c) => order.push(`text:${c}`),
		});

		expect(order).toEqual(['start-resolved', 'text:after']);
	});
});
