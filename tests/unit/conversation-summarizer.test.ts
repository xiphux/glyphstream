import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatMock = vi.hoisted(() => vi.fn());
// Mock only the network call; keep the REAL UpstreamError + parseContextOverflow so
// the overflow-retry path here exercises the actual classifier it branches on.
vi.mock('$lib/server/endpoints/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/endpoints/client')>();
	return { ...actual, chatCompletionSync: chatMock };
});

const acquireMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/concurrency', () => ({ acquireEndpointSlot: acquireMock }));

import {
	summarizeConversation,
	buildTranscript,
	SUMMARY_MAX_CHARS,
} from '$lib/server/memory/conversation-summarizer';
import { EmptyCompletionError, memoryInputBudget } from '$lib/server/memory/summarize-util';
import { UpstreamError } from '$lib/server/endpoints/client';
import type { ChatMessage } from '$lib/types/api';

/** llama.cpp's context-overflow 400, verbatim in shape. */
function overflow400(promptTokens: number, nCtx: number): UpstreamError {
	return new UpstreamError(
		`Endpoint "llama" returned HTTP 400`,
		400,
		JSON.stringify({
			error: {
				code: 400,
				message: `request (${promptTokens} tokens) exceeds the available context size (${nCtx} tokens), try increasing it`,
				type: 'exceed_context_size_error',
				n_prompt_tokens: promptTokens,
				n_ctx: nCtx,
			},
		}),
	);
}

const MODEL = {
	endpoint: { id: 'gpu', maxConcurrent: 1 },
	upstreamId: 'm',
	maxTokens: 500,
	temperature: 0.2,
	activeHours: '',
	timezone: 'UTC',
} as unknown as Parameters<typeof summarizeConversation>[0];

function mkMsg(role: 'user' | 'assistant', text: string): ChatMessage {
	return {
		id: `m-${Math.round(text.length)}-${role}`,
		role,
		parts: [{ type: 'text', text }],
	} as unknown as ChatMessage;
}

function reply(content: string) {
	chatMock.mockResolvedValue({ choices: [{ message: { content } }] });
}

beforeEach(() => {
	chatMock.mockReset();
	acquireMock.mockReset();
	acquireMock.mockResolvedValue({ release: vi.fn() });
});

describe('memoryInputBudget', () => {
	it('holds back a safety fraction of the window on top of the reserves', () => {
		// floor(100000 * 0.85) - 4000 - 400
		expect(memoryInputBudget(100000, 4000, 400, 1000)).toBe(80600);
	});

	it('floors at minBudget when the window is tiny (never zero/negative)', () => {
		// floor(1000 * 0.85) - 500 - 400 = -50 → clamped to the floor
		expect(memoryInputBudget(1000, 500, 400, 1000)).toBe(1000);
	});

	it('leaves headroom below the real window so a chars/4 undercount cannot overflow', () => {
		// Regression guard for the Gemma case: llama n_ctx 98304, memory max_tokens 4000.
		// The budget must sit well under 98304 so a ~122k-token transcript overflows the
		// fit-check and map-reduces, instead of being sent one-shot and rejected.
		const budget = memoryInputBudget(98304, 4000, 400, 1000);
		expect(budget).toBe(79158);
		expect(budget).toBeLessThan(98304);
	});
});

describe('buildTranscript', () => {
	it('renders role: text lines and drops non-text / empty messages', () => {
		const msgs = [
			mkMsg('user', 'hello there'),
			{
				id: 'img',
				role: 'assistant',
				parts: [{ type: 'image', mediaId: 'x' }],
			} as unknown as ChatMessage,
			mkMsg('assistant', 'general kenobi'),
		];
		expect(buildTranscript(msgs)).toBe('user: hello there\n\nassistant: general kenobi');
	});
});

describe('summarizeConversation', () => {
	it('one-shot when the transcript fits the budget', async () => {
		reply('A concise gist of the chat.');
		const out = await summarizeConversation(
			MODEL,
			[mkMsg('user', 'short'), mkMsg('assistant', 'reply')],
			8000,
		);
		expect(out).toBe('A concise gist of the chat.');
		expect(chatMock).toHaveBeenCalledTimes(1);
	});

	it('map-reduces when the transcript overflows the budget', async () => {
		reply('partial/final summary');
		// contextWindow=1000 → budget floors to 1000 tokens (~4000 chars). Three
		// ~450-token messages (~1350 total) force chunking: [m1,m2] + [m3] → 2 map
		// calls, then 1 reduce over the 2 partials = 3 calls total.
		const big = 'x '.repeat(900); // ~1800 chars ≈ 450 tokens
		const msgs = [mkMsg('user', big), mkMsg('assistant', big), mkMsg('user', big)];
		const out = await summarizeConversation(MODEL, msgs, 1000);
		expect(chatMock).toHaveBeenCalledTimes(3);
		expect(out).toBe('partial/final summary');
	});

	it('caps an over-long summary and collapses whitespace', async () => {
		reply('word '.repeat(400)); // ~2000 chars, whitespace-heavy
		const out = await summarizeConversation(
			MODEL,
			[mkMsg('user', 'a'), mkMsg('assistant', 'b')],
			8000,
		);
		expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
		expect(out.endsWith('…')).toBe(true);
		expect(out).not.toContain('  '); // collapsed
	});

	it('throws rather than returning an empty summary when the model yields nothing', async () => {
		// An empty completion is a 200, so it would otherwise pass for a result. It
		// fails the pass instead, which is what leaves the watermark unadvanced so the
		// sweep retries the conversation (see the worker test). The message carries the
		// two numbers that say WHY it was empty — here, a model that spent its whole
		// completion budget thinking and never reached an answer.
		chatMock.mockResolvedValue({
			choices: [
				{
					message: { content: '   ', reasoning_content: 'hmm'.repeat(10) },
					finish_reason: 'length',
				},
			],
		});
		await expect(
			summarizeConversation(MODEL, [mkMsg('user', 'a'), mkMsg('assistant', 'b')], 8000),
		).rejects.toThrow(/finish_reason=length.*reasoning_chars=30/);
	});

	it('does not silently drop a chunk when one map call comes back empty', async () => {
		// The map/reduce loop folds each call's result into a list, so an empty one used
		// to contribute nothing and let the reduce produce a gist missing a slice of the
		// transcript — a lossy summary indistinguishable from a whole one, stored with
		// the watermark stamped behind it.
		const long = 'x'.repeat(40_000);
		chatMock
			.mockResolvedValueOnce({ choices: [{ message: { content: 'part one' } }] })
			.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
			.mockResolvedValue({ choices: [{ message: { content: 'the gist' } }] });

		await expect(
			summarizeConversation(MODEL, [mkMsg('user', long), mkMsg('assistant', long)], 8000),
		).rejects.toThrow(EmptyCompletionError);
	});

	it('takes and releases an endpoint slot per model call', async () => {
		const release = vi.fn();
		acquireMock.mockResolvedValue({ release });
		reply('gist');
		await summarizeConversation(MODEL, [mkMsg('user', 'a'), mkMsg('assistant', 'b')], 8000);
		expect(acquireMock).toHaveBeenCalledWith('gpu', 1, expect.anything());
		expect(release).toHaveBeenCalledTimes(1);
	});
});

describe('summarizeConversation — recovery from an over-window rejection', () => {
	// The production failure: llama advertises Gemma's *trained* 131072 window while
	// the server is actually running --ctx-size 98304, so the transcript "fits" the
	// budget, goes one-shot, and is rejected at 104317 real tokens. The rejection
	// carries the true numbers; the retry has to use them.
	const ADVERTISED = 131072;
	const oneShotSized = () => [
		mkMsg('user', 'x'.repeat(200_000)), // ~50k est. tokens
		mkMsg('assistant', 'y'.repeat(200_000)), // ~100k total — under the 110511 budget
	];

	it('re-runs against a corrected budget and map-reduces instead of failing', async () => {
		chatMock
			.mockRejectedValueOnce(overflow400(104317, 98304))
			.mockResolvedValue({ choices: [{ message: { content: 'a gist' } }] });

		const out = await summarizeConversation(MODEL, oneShotSized(), ADVERTISED);

		expect(out).toBe('a gist');
		// 1 rejected one-shot, then the retry's 2 map calls + 1 reduce.
		expect(chatMock).toHaveBeenCalledTimes(4);
	});

	it('shrinks below the window the UPSTREAM reported, not the advertised one', async () => {
		chatMock
			.mockRejectedValueOnce(overflow400(104317, 98304))
			.mockResolvedValue({ choices: [{ message: { content: 'a gist' } }] });

		await summarizeConversation(MODEL, oneShotSized(), ADVERTISED);

		// Every retry payload must fit the REAL window (98304), with the completion
		// reserve still to come — the advertised 131072 would have let it through again.
		const sent = chatMock.mock.calls.slice(1).map((c) => c[1].messages[1].content as string);
		for (const payload of sent) {
			expect(Math.ceil(payload.length / 4)).toBeLessThan(98304 - MODEL.maxTokens);
		}
	});

	it('gives up (rethrows) once the retries are exhausted, so the worker can skip it', async () => {
		chatMock.mockRejectedValue(overflow400(104317, 98304)); // never fits, whatever we do

		await expect(summarizeConversation(MODEL, oneShotSized(), ADVERTISED)).rejects.toBeInstanceOf(
			UpstreamError,
		);
		expect(chatMock).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
	});

	it('does not retry a 400 that is not a context overflow', async () => {
		chatMock.mockRejectedValue(
			new UpstreamError('bad request', 400, '{"error":{"message":"nope"}}'),
		);
		await expect(summarizeConversation(MODEL, oneShotSized(), ADVERTISED)).rejects.toBeInstanceOf(
			UpstreamError,
		);
		expect(chatMock).toHaveBeenCalledTimes(1); // no shrink-and-retry
	});

	it('splits a single message too big for any budget, so shrinking converges', async () => {
		chatMock
			.mockRejectedValueOnce(overflow400(104317, 98304))
			.mockResolvedValue({ choices: [{ message: { content: 'a gist' } }] });

		// One enormous pasted message. Pre-split, this was an unplaceable chunk: no
		// budget could hold it, so the retry would shrink forever and re-send it whole.
		const out = await summarizeConversation(
			MODEL,
			[mkMsg('user', 'z'.repeat(400_000))],
			ADVERTISED,
		);

		expect(out).toBe('a gist');
		const retried = chatMock.mock.calls.slice(1).map((c) => c[1].messages[1].content as string);
		expect(retried.length).toBeGreaterThan(1); // it got chopped up
		for (const payload of retried) {
			expect(Math.ceil(payload.length / 4)).toBeLessThan(98304 - MODEL.maxTokens);
		}
	});
});
