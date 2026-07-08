import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({
	chatCompletionSync: chatMock,
	UpstreamError: class UpstreamError extends Error {},
}));

const acquireMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/concurrency', () => ({ acquireEndpointSlot: acquireMock }));

import {
	summarizeConversation,
	buildTranscript,
	SUMMARY_MAX_CHARS,
} from '$lib/server/memory/conversation-summarizer';
import type { ChatMessage } from '$lib/types/api';

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

	it('returns empty string when the model yields nothing', async () => {
		reply('   ');
		const out = await summarizeConversation(
			MODEL,
			[mkMsg('user', 'a'), mkMsg('assistant', 'b')],
			8000,
		);
		expect(out).toBe('');
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
