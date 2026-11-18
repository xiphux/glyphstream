/**
 * Holds the line on a `#q=` share prefill winning over a restored draft.
 *
 * The new-chat box restores the last unsent prompt from its draft slot before
 * `afterNavigate` reads the fragment, and the fragment is stripped either way —
 * so filling "only an empty box" silently discarded every share that arrived
 * while a draft existed (including the draft an earlier unsent share left).
 * The share wins, with an Undo that puts the draft back. A gallery-launched
 * regenerate prompt is a different explicit request and keeps the box.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { ModelEntry } from '#lib/types/api.js';
import { toast } from '#lib/toast.svelte.js';
import { GALLERY_LAUNCH_KEY } from '#lib/gallery-launch.js';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/env', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidate: vi.fn(async () => {}),
	refreshAll: vi.fn(async () => {}),
	afterNavigate: (callback: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
		stub().afterNavigate(callback),
	beforeNavigate: vi.fn(),
	pushState: vi.fn(),
}));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	holder.current = createKitStub('http://localhost:3000/');
	return { page: holder.current.page, navigating: holder.current.navigating };
});

import Harness from './_helpers/NewChatHarness.svelte';

const model: ModelEntry = {
	id: 'bridge::alpha',
	endpointId: 'bridge',
	upstreamId: 'alpha',
	displayName: 'alpha',
	ownedBy: null,
	kind: 'chat',
	kindKnown: true,
	group: 'Bridge',
	groupKey: 'bridge',
	supportsTools: false,
	contextWindow: null,
	promptStyle: null,
	promptHint: null,
};

const data = {
	user: { id: 'u1', displayName: 'Test', email: 't@e.st', role: 'admin', avatarUrl: null },
	prefs: { enterBehavior: 'send', favoriteModels: [], modelSets: [] },
	models: [model],
	customModels: [],
	defaultModelId: 'bridge::alpha',
	conversations: [],
	generatingIds: [],
	enabledSkills: [],
	featureCategories: [],
	deferredLoaded: true,
	mcpSettled: true,
};

const SHARED = 'shared from the share sheet';
const DRAFT = 'stale draft from three days ago';

beforeEach(() => {
	stub().reset();
	toast.dismiss();
	localStorage.clear();
	sessionStorage.clear();
	window.location.hash = '#q=' + encodeURIComponent(SHARED);
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: [model], endpoint_errors: [] }), { status: 200 }),
	) as typeof fetch;
});

const box = () => screen.getByPlaceholderText('How can I help you today?') as HTMLTextAreaElement;

function saveDraft(text: string) {
	localStorage.setItem(
		'glyphstream:composerDraft:new',
		JSON.stringify({ text, savedAt: Date.now() - 3 * 86_400_000 }),
	);
}

function renderPage() {
	render(Harness, { props: { data } });
	stub().enter();
	flushSync();
}

describe('new-chat page — #q= prefill', () => {
	it('fills an empty box from the fragment, with no toast', () => {
		renderPage();
		expect(box().value).toBe(SHARED);
		expect(toast.current).toBeNull();
	});

	it('replaces a restored draft and offers it back', async () => {
		saveDraft(DRAFT);
		renderPage();
		expect(box().value).toBe(SHARED);

		const action = toast.current?.action;
		expect(action?.label).toBe('Undo');
		await action!.handler();
		flushSync();
		expect(box().value).toBe(DRAFT);
	});

	it('leaves a gallery regenerate prompt in the box', () => {
		saveDraft(DRAFT);
		sessionStorage.setItem(
			GALLERY_LAUNCH_KEY,
			JSON.stringify({ kind: 'regenerate', prompt: 'a lighthouse at dusk', sourceModelId: null }),
		);
		renderPage();
		expect(box().value).toBe('a lighthouse at dusk');
	});
});
