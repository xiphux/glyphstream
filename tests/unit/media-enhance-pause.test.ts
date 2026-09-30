/**
 * Prompt enhancement behind a PAUSED enhancer endpoint.
 *
 * Enhancement runs before the branch asks for its generation slot, so it never
 * reaches the queue that reports a pause to the client. Without its own status,
 * pausing the utility-model endpoint left every image send reading
 * "Enhancing prompt…" for as long as the pause lasted — indistinguishable from
 * a hang.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedEndpoint } from '$lib/server/endpoints/config';

const enhancer = vi.hoisted(() => ({
	endpoint: {
		id: 'utility',
		resourceGroup: 'utility',
		resourceGroupMaxConcurrent: 1,
		release: null,
	} as unknown as LoadedEndpoint,
	upstreamId: 'gemma',
}));
vi.mock('$lib/server/tasks/image-enhancer-model', () => ({
	getImageEnhancerModel: () => enhancer,
}));
vi.mock('$lib/server/streaming/prompt-enhancer', () => ({
	enhancePrompt: async ({ prompt }: { prompt: string }) => ({
		enhanced: `${prompt}, enhanced`,
		changed: true,
	}),
}));

import {
	resetEndpointGatesForTests,
	setResourceGroupPaused,
} from '$lib/server/endpoints/concurrency';
import { runPromptEnhancement } from '$lib/server/streaming/media-enhance';
import type { StreamProgressEvent } from '$lib/types/api';

afterEach(() => resetEndpointGatesForTests());

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('runPromptEnhancement behind a paused enhancer', () => {
	it('says the enhancer is paused, then goes back to enhancing on resume', async () => {
		setResourceGroupPaused(enhancer.endpoint, true);
		const statuses: Array<string | null> = [];
		const write = (e: StreamProgressEvent) => statuses.push(e.status ?? null);

		const done = runPromptEnhancement(
			{ prompt: 'a cat', medium: 'image', isTextToMedia: true, enabled: true },
			{ write },
		);
		await flush();
		expect(statuses).toEqual(['Enhancing prompt…', 'Prompt enhancer paused…']);

		setResourceGroupPaused(enhancer.endpoint, false);
		await expect(done).resolves.toEqual({
			effectivePrompt: 'a cat, enhanced',
			originalPrompt: 'a cat',
		});
		expect(statuses).toEqual(['Enhancing prompt…', 'Prompt enhancer paused…', 'Enhancing prompt…']);
	});
});
