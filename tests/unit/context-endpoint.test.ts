/**
 * Route-handler test for GET /api/conversations/[id]/context.
 *
 * `buildContextBreakdown` has its own (thorough) unit tests, and they all pass a
 * hand-built branch — which is exactly why they could not catch the bug this file
 * exists to prevent.
 *
 * The send path walks the branch with `columns: 'serialization'`, a projection
 * that deliberately nulls `tokens_in` / `tokens_out` (the send path never needs
 * them). This endpoint copied that call. But the upstream's own `prompt_tokens`
 * is the ONE authoritative token measurement the app ever gets, and the gap
 * between it and our chars/4 estimate is where image tokens live — reporting it
 * is half the point of the panel. With the stripped projection it was pinned to
 * null, and that row of the panel silently never rendered.
 *
 * A unit test over `buildContextBreakdown` can't see this: it's a mismatch
 * BETWEEN two correct components. So the assertion lives here, at the seam.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '$lib/types/api';

const mocks = vi.hoisted(() => ({
	walkActiveBranch: vi.fn<(...a: unknown[]) => unknown[]>(),
}));

vi.mock('$lib/server/db/queries/messages', () => ({
	walkActiveBranch: (...a: unknown[]) => mocks.walkActiveBranch(...a),
}));
vi.mock('$lib/server/auth/guard', () => ({
	requireUser: () => {},
	requireFound: <T>(v: T) => v,
}));
vi.mock('$lib/server/db/queries/conversations', () => ({
	getConversationMeta: () => ({ id: 'c1', modelId: 'e::m', systemPrompt: null }),
}));
vi.mock('$lib/server/db/queries/media', () => ({ getMediaForUser: () => null }));
vi.mock('$lib/server/db/queries/user-preferences', () => ({
	getUserPreferences: () => null,
	PERSONA_PART_SEPARATOR: '\n\n',
}));
vi.mock('$lib/server/endpoints/registry', () => ({
	getEndpoint: () => ({ supportsTools: false }),
}));
vi.mock('$lib/server/endpoints/list-models', () => ({
	listAllModels: async () => [
		{ endpointId: 'e', upstreamId: 'm', supportsTools: false, contextWindow: 65536 },
	],
}));
vi.mock('$lib/server/endpoints/model-id', () => ({
	parseModelId: () => ({ endpointId: 'e', upstreamId: 'm' }),
}));
vi.mock('$lib/server/chat/private-seal', () => ({ resolveDisabledFeatures: () => [] }));
vi.mock('$lib/server/chat/persona-context', () => ({ composePersonaPromptParts: () => [] }));
vi.mock('$lib/server/chat/tool-context', () => ({
	buildChatToolContext: async () => ({
		systemPrompt: null,
		environmentBlock: 'today is a day',
		skillsCatalog: null,
		toolSearchHint: null,
		toolDefs: [],
		needsApproval: () => false,
		unavailableMcpServers: [],
	}),
	buildCanvasInjection: () => ({ tailText: null, toolDefs: [] }),
}));
vi.mock('$lib/server/media/vision-variant', () => ({ cachedVisionVariantSize: async () => null }));

import { GET } from '../../src/routes/api/conversations/[id]/context/+server';

function msg(over: Partial<ChatMessage>): ChatMessage {
	return {
		id: 'm',
		role: 'assistant',
		parts: [{ type: 'text', text: 'hello' }],
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

async function call() {
	const res = await GET({
		locals: { user: { id: 'u1' } },
		params: { id: 'c1' },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
	return res.json();
}

beforeEach(() => {
	mocks.walkActiveBranch.mockReset();
	mocks.walkActiveBranch.mockReturnValue([msg({ id: 'a1', tokensIn: 4210, tokensOut: 300 })]);
});

describe('GET /api/conversations/[id]/context', () => {
	it("walks the branch with the projection that actually carries usage, not the send path's", async () => {
		// `columns: 'serialization'` nulls tokens_in — see walkActiveBranch. Asking
		// for it here silently blanks `reportedPromptTokens` forever.
		await call();
		expect(mocks.walkActiveBranch).toHaveBeenCalledWith('c1', { columns: 'all' });
	});

	it("reports the upstream's own prompt_tokens, the only authoritative number we get", async () => {
		const body = await call();
		expect(body.reportedPromptTokens).toBe(4210);
	});

	it('reports null when the thread has genuinely not completed a turn', async () => {
		mocks.walkActiveBranch.mockReturnValue([msg({ id: 'u1', role: 'user', tokensIn: null })]);
		const body = await call();
		expect(body.reportedPromptTokens).toBeNull();
	});
});
