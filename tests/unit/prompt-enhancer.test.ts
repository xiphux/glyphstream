import { afterEach, describe, expect, it, vi } from 'vitest';

// Control the upstream call without touching the network. The fake error class
// must be created inside vi.hoisted so it exists when the (hoisted) mock factory
// runs.
const { syncMock, FakeUpstreamError } = vi.hoisted(() => {
	class FakeUpstreamError extends Error {}
	return { syncMock: vi.fn(), FakeUpstreamError };
});
vi.mock('$lib/server/endpoints/client', () => ({
	chatCompletionSync: syncMock,
	UpstreamError: FakeUpstreamError,
}));

import { enhancePrompt, sanitizeEnhanced } from '$lib/server/streaming/prompt-enhancer';
import type { ResolvedImageEnhancerModel } from '$lib/server/tasks/image-enhancer-model';

const model: ResolvedImageEnhancerModel = {
	// Endpoint is only forwarded to the (mocked) client; its shape is irrelevant here.
	endpoint: { id: 'enh' } as unknown as ResolvedImageEnhancerModel['endpoint'],
	upstreamId: 'enhancer-model',
	maxTokens: 400,
	temperature: 0.7,
	styleInstructionOverrides: {},
};

function reply(content: string) {
	syncMock.mockResolvedValue({ choices: [{ message: { content } }] });
}

afterEach(() => syncMock.mockReset());

describe('enhancePrompt', () => {
	it('returns the rewritten prompt and changed=true on success', async () => {
		reply('1girl, solo, silver hair, holding sword, forest');
		const res = await enhancePrompt({ prompt: 'a girl with a sword', style: 'booru-tags', model });
		expect(res.changed).toBe(true);
		expect(res.enhanced).toBe('1girl, solo, silver hair, holding sword, forest');
	});

	it('passes the per-model hint into the system prompt', async () => {
		reply('masterpiece, best quality, 1girl');
		await enhancePrompt({
			prompt: 'a girl',
			style: 'booru-tags',
			hint: 'prefix with masterpiece, best quality',
			model,
		});
		const sentSystem = syncMock.mock.calls[0][1].messages[0].content as string;
		expect(sentSystem).toContain('prefix with masterpiece, best quality');
	});

	it('uses the clarify-only template when style is null', async () => {
		reply('a girl holding a sword in a forest');
		await enhancePrompt({ prompt: 'a girl with a sword', style: null, model });
		const sentSystem = syncMock.mock.calls[0][1].messages[0].content as string;
		// The clarify-only template tells the model to preserve the user's format.
		expect(sentSystem.toLowerCase()).toContain('keep the format');
	});

	it('is non-fatal: returns the original + changed=false on upstream error', async () => {
		syncMock.mockRejectedValue(new FakeUpstreamError('boom'));
		const res = await enhancePrompt({ prompt: 'a cat', style: 'natural-language', model });
		expect(res).toEqual({ enhanced: 'a cat', changed: false });
	});

	it('is non-fatal: returns the original on an empty response', async () => {
		reply('   ');
		const res = await enhancePrompt({ prompt: 'a cat', style: 'natural-language', model });
		expect(res).toEqual({ enhanced: 'a cat', changed: false });
	});

	it('does not call upstream for an empty prompt', async () => {
		const res = await enhancePrompt({ prompt: '   ', style: 'booru-tags', model });
		expect(res.changed).toBe(false);
		expect(syncMock).not.toHaveBeenCalled();
	});

	it('reports changed=false when the model echoes the prompt back', async () => {
		reply('a cat');
		const res = await enhancePrompt({ prompt: 'a cat', style: 'natural-language', model });
		expect(res.changed).toBe(false);
	});
});

describe('sanitizeEnhanced', () => {
	it('strips a fenced code block', () => {
		expect(sanitizeEnhanced('```\n1girl, solo\n```')).toBe('1girl, solo');
	});

	it('strips a leading label and surrounding quotes', () => {
		expect(sanitizeEnhanced('Enhanced prompt: "a cat on a mat"')).toBe('a cat on a mat');
		expect(sanitizeEnhanced('Prompt - a cat')).toBe('a cat');
	});

	it('leaves a clean prompt untouched', () => {
		expect(sanitizeEnhanced('1girl, solo, forest')).toBe('1girl, solo, forest');
	});
});
