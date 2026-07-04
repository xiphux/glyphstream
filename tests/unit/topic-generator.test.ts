import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/endpoints/client', () => ({ chatCompletionSync: chatMock }));

import {
	buildTopicPrompt,
	fallbackTopic,
	generateMemoryTopic,
	sanitizeTopic,
} from '$lib/server/tasks/topic-generator';
import type { ResolvedTaskModel } from '$lib/server/tasks/task-model';

const MODEL = { endpoint: {}, upstreamId: 'm' } as unknown as ResolvedTaskModel;

function reply(content: string) {
	chatMock.mockResolvedValue({ choices: [{ message: { content } }] });
}

beforeEach(() => chatMock.mockReset());

describe('sanitizeTopic', () => {
	it('strips a leading "Topic:" label', () => {
		expect(sanitizeTopic('Topic: Employer')).toBe('Employer');
	});
	it('strips a single pair of surrounding quotes', () => {
		expect(sanitizeTopic('"Pet details"')).toBe('Pet details');
	});
	it('collapses whitespace and drops trailing punctuation', () => {
		expect(sanitizeTopic('Kids   names.')).toBe('Kids names');
	});
	it('caps length', () => {
		expect(sanitizeTopic('x'.repeat(200)).length).toBeLessThanOrEqual(80);
	});
});

describe('buildTopicPrompt', () => {
	it('wraps the content in <memory> tags with a system + user message', () => {
		const msgs = buildTopicPrompt('likes tea')!;
		expect(msgs).toHaveLength(2);
		expect(msgs[0].role).toBe('system');
		expect(msgs[1].content).toContain('<memory>');
		expect(msgs[1].content).toContain('likes tea');
	});
	it('returns null for empty content', () => {
		expect(buildTopicPrompt('   ')).toBeNull();
	});
});

describe('fallbackTopic', () => {
	it('uses the first several words of the content', () => {
		expect(fallbackTopic('the quick brown fox jumps over the lazy dog again')).toBe(
			'the quick brown fox jumps over the lazy',
		);
	});
	it('never returns empty', () => {
		expect(fallbackTopic('   ')).toBe('Saved note');
	});
});

describe('generateMemoryTopic', () => {
	it('returns the sanitized label from the model', async () => {
		reply('"Employer"');
		expect(await generateMemoryTopic(MODEL, 'works at Acme')).toBe('Employer');
	});

	it('returns null when the model returns nothing usable', async () => {
		reply('   ');
		expect(await generateMemoryTopic(MODEL, 'works at Acme')).toBeNull();
	});

	// Upstream-error propagation (generateMemoryTopic does NOT swallow, so the
	// worker can distinguish "retry" from "fallback") is covered end-to-end by
	// memory-topic-backfill.test.ts's "endpoint fails → rows stay queued" — a
	// rejecting mock asserted directly here trips vitest's unhandled-rejection
	// detection.

	it('returns null for empty content without calling the model', async () => {
		expect(await generateMemoryTopic(MODEL, '   ')).toBeNull();
		expect(chatMock).not.toHaveBeenCalled();
	});
});
