/**
 * The context readout must price what the send path actually sends.
 *
 * CLAUDE.md: "the upstream payload is rent" — the readout behind
 * `/api/conversations/:id/context` is how a user sees that rent, so a payload
 * piece the sender adds and the pricer misses (or prices differently) is a
 * readout that lies. The two assemble the request separately, so nothing kept
 * them in step but comments saying "exactly as the send path does".
 *
 * This sends a real turn through the messages route (only the endpoint, the
 * model list and the relay are stubbed: the relay captures the body instead of
 * calling upstream), prices the same conversation through the context route,
 * and checks the priced inputs against the sent body: the tool list, the
 * canvas tail block, and every system-prompt piece.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';
import type { ChatCompletionRequest } from '#lib/server/endpoints/client.js';
import type { ContextBreakdownInput } from '#lib/server/chat/context-breakdown.js';

const ENDPOINT = {
	id: 'mock',
	displayName: 'Mock',
	baseUrl: 'http://localhost/v1',
	apiKey: null,
	requestTimeoutSeconds: 120,
	providerQuirk: 'passthrough',
	groupBy: 'endpoint',
	supportsTools: true,
	maxConcurrent: Infinity,
	resourceGroup: 'mock',
	resourceGroupMaxConcurrent: Infinity,
	release: null,
	contextWindow: null,
	modelContextWindows: {},
	modelPromptStyles: {},
	modelPromptHints: {},
} as unknown as LoadedEndpoint;

const mocks = vi.hoisted(() => ({
	sent: null as ChatCompletionRequest | null,
	priced: null as ContextBreakdownInput | null,
}));

vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: () => ENDPOINT,
	listEndpoints: () => [ENDPOINT],
}));
vi.mock('#lib/server/endpoints/list-models.js', () => ({
	listAllModels: async () => [
		{
			id: 'mock::m',
			endpointId: 'mock',
			upstreamId: 'm',
			kind: 'chat',
			supportsTools: true,
			contextWindow: 32_000,
		},
	],
}));
vi.mock('#lib/server/streaming/relay.js', () => ({
	startStreamingRelay: async (opts: {
		requestBody: ChatCompletionRequest;
		onComplete: () => void;
	}) => {
		mocks.sent = opts.requestBody;
		opts.onComplete();
		return new ReadableStream({ start: (c) => c.close() });
	},
}));
vi.mock('#lib/server/chat/context-breakdown.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/server/chat/context-breakdown.js')>();
	return {
		...real,
		buildContextBreakdown: (input: ContextBreakdownInput) => {
			mocks.priced = input;
			return real.buildContextBreakdown(input);
		},
	};
});

// The real built-in tools, registered as the server registers them.
import '#lib/server/tools/index.js';
import { POST } from '../../src/routes/api/conversations/[id]/messages/+server';
import { GET } from '../../src/routes/api/conversations/[id]/context/+server';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage } from '#lib/server/db/queries/messages.js';
import { setUserPreferences } from '#lib/server/db/queries/user-preferences.js';
import { createCanvas } from '#lib/server/db/queries/artifacts.js';
import { CHECK_IN_INSTRUCTIONS, TEXTING_INSTRUCTIONS } from '#lib/server/chat/reply-style.js';
import { resetInFlight } from '#lib/server/streaming/in-flight.js';
import { resetConfigCachesForTests } from '#lib/server/util/config-cache.js';

let userId: string;
let conversationId: string;

beforeEach(() => {
	createTestDb();
	resetConfigCachesForTests();
	mocks.sent = null;
	mocks.priced = null;
	userId = seedUser().id;
	setUserPreferences(userId, { name: 'Sam', aboutYou: 'Writes Rust for a living.' });
	conversationId = createConversation({
		userId,
		endpointId: 'mock',
		modelId: 'mock::m',
		modelKind: 'chat',
		// So the reply style's instructions are among the pieces priced.
		replyStyle: 'texting',
	}).id;
	const q = appendMessage({
		conversationId,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'Draft a release note.' }],
	});
	const a = appendMessage({
		conversationId,
		parentMessageId: q.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'Here is a first draft in the canvas.' }],
	});
	createCanvas({
		userId,
		conversationId,
		title: 'Release note',
		content: '# v1.2\n\n- Faster thumbnails',
		contentHtml: null,
		createdByMessageId: a.id,
	});
});
afterEach(() => {
	resetInFlight();
	closeTestDb();
});

const event = (method: 'POST' | 'GET', body?: unknown) => {
	const path = method === 'POST' ? 'messages?stream=1' : 'context';
	const url = new URL(`http://x/api/conversations/${conversationId}/${path}`);
	return {
		locals: { user: { id: userId } },
		params: { id: conversationId },
		url,
		request: new Request(url, {
			method,
			...(body
				? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
				: {}),
		}),
	};
};

async function sendAndPrice(): Promise<{
	sent: ChatCompletionRequest;
	priced: ContextBreakdownInput;
}> {
	const res = (await POST(event('POST', { text: 'Make it shorter.' }) as never)) as Response;
	await res.text();
	await GET(event('GET') as never);
	expect(mocks.sent).not.toBeNull();
	expect(mocks.priced).not.toBeNull();
	return { sent: mocks.sent!, priced: mocks.priced! };
}

describe('the context readout prices what the send path sends', () => {
	it('prices exactly the tools[] that is sent, in order', async () => {
		const { sent, priced } = await sendAndPrice();
		expect(sent.tools?.length ?? 0).toBeGreaterThan(0);
		expect(priced.toolDefs).toEqual(sent.tools);
	});

	it('prices the canvas tail block that is sent last', async () => {
		const { sent, priced } = await sendAndPrice();
		const last = sent.messages.at(-1)!;
		expect(last.role).toBe('system');
		expect(priced.canvasTailText).toBeTruthy();
		expect(last.content).toBe(priced.canvasTailText);
	});

	it('prices every piece of the system prompt that is sent, and nothing else', async () => {
		const { sent, priced } = await sendAndPrice();
		const system = sent.messages[0];
		expect(system.role).toBe('system');
		const pieces = [
			priced.environmentBlock,
			priced.customSystemPrompt,
			priced.replyStyleInstructions,
			...priced.personaParts.map((p) => p.text),
			priced.skillsCatalog,
			priced.toolSearchHint,
			priced.reactionsHint,
		].filter((p): p is string => !!p);
		expect(pieces.length).toBeGreaterThan(2);
		expect(priced.replyStyleInstructions).toBe(`${TEXTING_INSTRUCTIONS} ${CHECK_IN_INSTRUCTIONS}`);
		for (const piece of pieces) expect(system.content).toContain(piece);
		// Joined by blank lines and nothing more: the priced pieces are the whole
		// prompt, so the readout can't be missing a block the sender added.
		const content = system.content as string;
		const separators = content.length - pieces.reduce((n, p) => n + p.length, 0);
		expect(separators).toBe('\n\n'.length * (pieces.length - 1));
	});
});
