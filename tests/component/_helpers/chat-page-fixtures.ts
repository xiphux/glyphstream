/**
 * Load data for tests that mount the real chat page through
 * `ChatPageHarness.svelte`: one chat model, and the page data the layout and
 * `chat/[id]` loads would hand it. Shapes are loose on purpose (the harness
 * casts), so a test spells out only the rows it reasons about.
 */
import type { ModelEntry } from '#lib/types/api.js';

export const model: ModelEntry = {
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
	contextWindow: 8000,
	promptStyle: null,
	promptHint: null,
};

/** A persisted message row as the page load serializes it. */
export function row(id: string, role: 'user' | 'assistant', text: string) {
	return {
		id,
		role,
		parts: [{ type: 'text', text }],
		contentHtml: null,
		createdAt: 1000,
		...(role === 'assistant' ? { modelId: model.id } : {}),
	};
}

/** A branch whose reported usage (6.2k of the model's 8k) is over a 50%
 *  auto-compaction threshold. */
export function longBranch() {
	const out: unknown[] = [];
	for (let i = 0; i < 24; i++) {
		const assistant = i % 2 === 1;
		out.push({
			id: `a-m${i}`,
			role: assistant ? 'assistant' : 'user',
			parts: [{ type: 'text', text: 'x'.repeat(400) }],
			contentHtml: null,
			createdAt: 1000 + i,
			...(assistant ? { tokensIn: 6000, tokensOut: 200, modelId: model.id } : {}),
		});
	}
	return out;
}

export function conversation(id: string, isPrivate: boolean, messages: unknown[]) {
	return {
		id,
		title: id,
		modelId: model.id,
		modelKind: 'chat',
		customModelId: null,
		avatarMediaId: null,
		disabledFeatures: [],
		hasEarlierMessages: false,
		messages,
		photos: null,
		private: isPrivate,
		replyStyle: 'standard',
		sceneBefore: null,
		startingScene: null,
	};
}

export function pageData(
	conv: ReturnType<typeof conversation>,
	opts: { autoCompaction?: boolean } = {},
) {
	return {
		user: { id: 'u1', displayName: 'Test', email: 't@e.st', role: 'admin', avatarUrl: null },
		prefs: {
			enterBehavior: 'send',
			favoriteModels: [],
			modelSets: [],
			autoCompactionEnabled: opts.autoCompaction ?? false,
			autoCompactionThreshold: 50,
		},
		models: [model],
		customModels: [],
		defaultModelId: model.id,
		conversations: [],
		generatingIds: [],
		enabledSkills: [],
		featureCategories: [],
		deferredLoaded: true,
		mcpSettled: true,
		scheduledRunPromptId: null,
		checkInsOn: false,
		checkIn: null,
		conversation: conv,
		referencedModels: [model],
		answeredModelIds: [model.id],
		hasImageModel: false,
		assistantLabel: null,
		presetAvatarMediaId: null,
		inFlightSince: null,
		inFlightGeneratingSince: null,
		fanout: null,
		canvases: [],
	};
}

/** The composer's textarea. */
export const composerBox = () => document.querySelector('textarea') as HTMLTextAreaElement;

/** An SSE body the test feeds frame by frame. */
export function sseStream() {
	const enc = new TextEncoder();
	let ctl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
	return {
		body,
		emit: (e: unknown) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)),
		close: () => ctl.close(),
	};
}

/** The URL string of a fetch input. */
export function fetchUrl(input: RequestInfo | URL): string {
	return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
