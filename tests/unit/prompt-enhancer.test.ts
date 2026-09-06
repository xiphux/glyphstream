import type { chatCompletionSync } from '$lib/server/endpoints/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Control the upstream call without touching the network. The fake error class
// must be created inside vi.hoisted so it exists when the (hoisted) mock factory
// runs.
const { syncMock, FakeUpstreamError } = vi.hoisted(() => {
	class FakeUpstreamError extends Error {}
	return { syncMock: vi.fn<typeof chatCompletionSync>(), FakeUpstreamError };
});
vi.mock('$lib/server/endpoints/client', () => ({
	chatCompletionSync: syncMock,
	UpstreamError: FakeUpstreamError,
}));

import {
	enhancePrompt,
	sanitizeEnhanced,
	trivialNormalize,
} from '$lib/server/streaming/prompt-enhancer';
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

	it('re-throws a user Stop (AbortError) instead of falling back to the original', async () => {
		// A Stop must cancel the whole generation, not silently use the original —
		// so the abort propagates out (the relay's prepare step turns it into a
		// Cancelled), unlike a genuine failure which is swallowed above.
		syncMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
		await expect(
			enhancePrompt({ prompt: 'a cat', style: 'natural-language', model }),
		).rejects.toThrow();
	});

	it('re-throws when the abort signal fired, even if the surfaced error is generic', async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		syncMock.mockRejectedValue(new Error('socket hang up'));
		await expect(
			enhancePrompt({ prompt: 'a cat', style: 'natural-language', model, signal: ctrl.signal }),
		).rejects.toThrow();
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

	it('treats a trailing-period-only difference as unchanged', async () => {
		// Clarify-only often just appends a full stop — not a real enhancement,
		// so it must NOT surface the enhanced-vs-original split.
		reply('A cat sleeping in the sun.');
		const res = await enhancePrompt({
			prompt: 'A cat sleeping in the sun',
			style: null,
			model,
		});
		expect(res.changed).toBe(false);
	});

	it('treats a surrounding-whitespace-only difference as unchanged', async () => {
		reply('  a cat  ');
		const res = await enhancePrompt({ prompt: 'a cat', style: null, model });
		expect(res.changed).toBe(false);
	});

	it('still reports a genuine change that merely also adds a period', async () => {
		reply('A fluffy cat napping in warm sunlight.');
		const res = await enhancePrompt({
			prompt: 'A cat sleeping in the sun',
			style: 'natural-language',
			model,
		});
		expect(res.changed).toBe(true);
	});
});

describe('enhancePrompt — prompt already in the target style', () => {
	const tags = '1girl, solo, long hair, holding sword, forest, sunbeam';
	const prose =
		'A weathered fisherman mends his nets on a stone pier at first light, gulls circling.';

	function systemOf(call = 0) {
		return syncMock.mock.calls[call][1].messages[0].content as string;
	}

	it('swaps in the preserve template instead of the style template', async () => {
		reply(tags);
		await enhancePrompt({ prompt: tags, style: 'booru-tags', model });
		const sent = systemOf();
		expect(sent).toContain('ALREADY MATCHED');
		expect(sent.toLowerCase()).toContain('do not restyle');
		// The restyle instruction must be gone, or it fights the preserve one.
		expect(sent).not.toContain('Target style: STRICT BOORU (DANBOORU) TAGS.');
	});

	it('drops the "Rewrite this" framing from the user turn', async () => {
		reply(tags);
		await enhancePrompt({ prompt: tags, style: 'booru-tags', model });
		const sentUser = syncMock.mock.calls[0][1].messages[1].content as string;
		expect(sentUser).toContain('WITHOUT restyling');
		expect(sentUser).not.toContain('Rewrite this');
	});

	it('treats a comma list as matching either tag style', async () => {
		reply(tags);
		await enhancePrompt({ prompt: tags, style: 'keyword-soup', model });
		expect(systemOf()).toContain('ALREADY MATCHED');
	});

	it('still restyles when the prompt is in a DIFFERENT format', async () => {
		reply('1girl, solo');
		await enhancePrompt({ prompt: prose, style: 'booru-tags', model });
		const sent = systemOf();
		expect(sent).not.toContain('ALREADY MATCHED');
		expect(sent).toContain('Target style: STRICT BOORU (DANBOORU) TAGS.');
	});

	it('still enhances a short/ambiguous prompt normally', async () => {
		reply('1girl, solo, sword');
		await enhancePrompt({ prompt: 'a girl with a sword', style: 'booru-tags', model });
		expect(systemOf()).not.toContain('ALREADY MATCHED');
	});

	it('keeps the per-model hint (additive nuance survives preserve mode)', async () => {
		reply(tags);
		await enhancePrompt({
			prompt: tags,
			style: 'booru-tags',
			hint: 'prefix with masterpiece, best quality',
			model,
		});
		expect(systemOf()).toContain('prefix with masterpiece, best quality');
	});

	it('outranks an operator style-instruction override', async () => {
		// The override retunes how to RESTYLE; preserve mode has decided not to.
		reply(tags);
		await enhancePrompt({
			prompt: tags,
			style: 'booru-tags',
			model: { ...model, styleInstructionOverrides: { 'booru-tags': 'OPERATOR OVERRIDE TEXT' } },
		});
		const sent = systemOf();
		expect(sent).toContain('ALREADY MATCHED');
		expect(sent).not.toContain('OPERATOR OVERRIDE TEXT');
	});

	it('never applies to video — the video styles are not detectable', async () => {
		reply('a dog runs across a field, camera tracking alongside');
		await enhancePrompt({
			prompt:
				'A lone astronaut walks across red dunes as the camera slowly dollies in, cold blue dusk light.',
			medium: 'video',
			style: 'cinematic-prose',
			model,
		});
		expect(systemOf()).not.toContain('ALREADY MATCHED');
	});
});

describe('enhancePrompt — video medium', () => {
	it('uses the video (cinematographer) base + video style template', async () => {
		reply(
			'A lone astronaut walks across red dunes as the camera slowly dollies in, cold blue dusk light.',
		);
		await enhancePrompt({
			prompt: 'astronaut on mars',
			medium: 'video',
			style: 'cinematic-prose',
			model,
		});
		const sentSystem = syncMock.mock.calls[0][1].messages[0].content as string;
		// Video base prompt, not the image "image-generation prompt engineer" one.
		expect(sentSystem).toContain('cinematographer');
		expect(sentSystem.toLowerCase()).toContain('present tense');
		// The cinematic-prose style instruction.
		expect(sentSystem.toUpperCase()).toContain('CINEMATIC NATURAL-LANGUAGE PROSE');
	});

	it('wraps the user message as a video prompt', async () => {
		reply('something cinematic');
		await enhancePrompt({
			prompt: 'a dog running',
			medium: 'video',
			style: 'structured-cinematic',
			model,
		});
		const sentUser = syncMock.mock.calls[0][1].messages[1].content as string;
		expect(sentUser).toContain('Rewrite this video prompt');
	});

	it('uses the video clarify-only template when style is null', async () => {
		reply('a dog runs across a field, camera tracking alongside');
		await enhancePrompt({ prompt: 'a dog running', medium: 'video', style: null, model });
		const sentSystem = syncMock.mock.calls[0][1].messages[0].content as string;
		expect(sentSystem.toLowerCase()).toContain("preserve the user's format");
		// Video clarify-only nudges toward adding motion/camera when absent.
		expect(sentSystem.toLowerCase()).toContain('motion');
	});

	it('defaults to the image medium when none is given', async () => {
		reply('1girl, solo');
		await enhancePrompt({ prompt: 'a girl', style: 'booru-tags', model });
		const sentUser = syncMock.mock.calls[0][1].messages[1].content as string;
		expect(sentUser).toContain('Rewrite this image prompt');
	});
});

describe('trivialNormalize', () => {
	it('strips trailing periods and surrounding whitespace, keeps ! and ?', () => {
		expect(trivialNormalize('a cat.')).toBe('a cat');
		expect(trivialNormalize('  a cat .  ')).toBe('a cat');
		expect(trivialNormalize('a cat...')).toBe('a cat');
		expect(trivialNormalize('a cat!')).toBe('a cat!');
		expect(trivialNormalize('a cat?')).toBe('a cat?');
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
