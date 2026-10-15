/**
 * The one builder both the send path and the approval resume use for every
 * upstream chat request (chat/upstream-request.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
// Importing the barrel registers the built-in tools.
import { list, type OpenAIToolDefinition } from '#lib/server/tools/index.js';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage, walkActiveBranch } from '#lib/server/db/queries/messages.js';
import { createCanvas } from '#lib/server/db/queries/artifacts.js';
import { buildUpstreamRequest, cachedMediaResolver } from '#lib/server/chat/upstream-request.js';

let userId: string;
let conversationId: string;

beforeEach(() => {
	createTestDb();
	userId = seedUser().id;
	conversationId = createConversation({
		userId,
		endpointId: 'e',
		modelId: 'e::m',
		modelKind: 'chat',
	}).id;
	appendMessage({
		conversationId,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'hi' }],
	});
});
afterEach(() => closeTestDb());

const def = (name: string): OpenAIToolDefinition => ({
	type: 'function',
	function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

function build(over: Partial<Parameters<typeof buildUpstreamRequest>[0]> = {}) {
	return buildUpstreamRequest({
		conversationId,
		userId,
		upstreamModelId: 'm',
		branch: walkActiveBranch(conversationId, { columns: 'serialization' }),
		systemPrompt: 'Be brief.',
		baseToolDefs: [],
		parameters: null,
		disabledFeatures: [],
		supportsTools: true,
		resolveMediaDataUrl: async () => 'data:,',
		...over,
	});
}

describe('buildUpstreamRequest', () => {
	it('sends the system prompt, then the branch, and always asks for usage', async () => {
		const req = await build();
		expect(req.model).toBe('m');
		expect(req.messages.map((m) => m.role)).toEqual(['system', 'user']);
		expect(req.messages[0].content).toBe('Be brief.');
		expect(req.stream_options).toEqual({ include_usage: true });
		expect(req.tools).toBeUndefined();
		expect(req.tool_choice).toBeUndefined();
	});

	it('dedupes the base tools and appends the ones searched up this turn', async () => {
		const searchable = list().find((t) => t.definition.function.name)?.definition;
		expect(searchable).toBeDefined();
		const req = await build({
			baseToolDefs: [def('a'), def('b'), def('a')],
			activatedToolNames: [searchable!.function.name],
		});
		expect(req.tools!.map((t) => t.function.name)).toEqual(['a', 'b', searchable!.function.name]);
		expect(req.tool_choice).toBe('auto');
	});

	it('with a canvas open, appends searched-up tools after update_canvas, never before', async () => {
		// Within a turn tools[] may only grow at the end: moving update_canvas
		// between iterations would re-prefill the whole conversation.
		createCanvas({
			userId,
			conversationId,
			title: 'Doc',
			content: 'hello',
			contentHtml: null,
			createdByMessageId: null,
		});
		const searched = list()
			.map((t) => t.definition.function.name)
			.find((n) => n !== 'update_canvas')!;
		const first = await build({ baseToolDefs: [def('a')] });
		const next = await build({ baseToolDefs: [def('a')], activatedToolNames: [searched] });
		const names = (r: typeof first) => r.tools!.map((t) => t.function.name);
		expect(names(first)).toEqual(['a', 'update_canvas']);
		expect(names(next)).toEqual(['a', 'update_canvas', searched]);
		// The canvas block stays the last message either way.
		expect(next.messages.at(-1)!.content).toContain('hello');
	});

	it('forwards only the sampling parameters that are set', async () => {
		const req = await build({ parameters: { temperature: 0.2 } });
		expect(req.temperature).toBe(0.2);
		expect('top_p' in req).toBe(false);
		expect('max_tokens' in req).toBe(false);
	});
});

describe('cachedMediaResolver', () => {
	it('resolves each media id once', async () => {
		let reads = 0;
		const resolve = cachedMediaResolver(async (id) => {
			reads++;
			return `data:${id}`;
		});
		expect(await resolve('x')).toBe('data:x');
		expect(await resolve('x')).toBe('data:x');
		await resolve('y');
		expect(reads).toBe(2);
	});
});
