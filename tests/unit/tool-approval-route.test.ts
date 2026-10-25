/**
 * Route-handler tests for POST /api/conversations/[id]/tool-approval.
 *
 * The approval resume is the send route's anti-drift twin: both assemble the
 * upstream payload through `buildChatToolContext`, and a resumed turn must put
 * the same `tools[]` on the wire the send path would. Real DB (conversation,
 * branch, pending tool_result rewrite); mocked edges are the endpoint registry,
 * the tool context, tool execution and the relay, whose `requestBody` is what
 * these tests read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';
import type { OpenAIToolDefinition } from '#lib/server/tools/types.js';

const ENDPOINT: LoadedEndpoint = {
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
};

type RelayOpts = {
	requestBody: { tools?: OpenAIToolDefinition[] };
	rebuildRequestBody: (o?: { activatedToolNames?: string[] }) => Promise<{
		tools?: OpenAIToolDefinition[];
	}>;
};

const mocks = vi.hoisted(() => ({
	testDb: null as unknown as TestDB,
	toolDefs: [] as unknown[],
	relayCalls: [] as unknown[],
	/** Runs once per executed tool call; a test can make it slow. */
	execute: null as unknown as () => Promise<void>,
	executions: 0,
}));

vi.mock('#lib/server/endpoints/registry.js', () => ({
	getEndpoint: () => ENDPOINT,
}));
vi.mock('#lib/server/endpoints/list-models.js', () => ({
	listAllModels: async () => [],
}));
vi.mock('#lib/server/mcp/bootstrap.js', () => ({
	awaitMcpReady: async () => {},
}));
vi.mock('#lib/server/chat/tool-context.js', () => ({
	buildChatToolContext: async () => ({
		systemPrompt: null,
		toolDefs: mocks.toolDefs,
		needsApproval: () => false,
		unavailableMcpServers: [],
	}),
	augmentRequestForCanvas: (body: unknown) => body,
}));
vi.mock('#lib/server/chat/persona-context.js', () => ({
	composePersonaPrompt: () => null,
}));
vi.mock('#lib/server/streaming/tool-execution.js', () => ({
	executeOneToolCall: async () => {
		mocks.executions++;
		await mocks.execute();
		return { execution: { content: '{"ok":true}', isError: false }, mediaParts: [] };
	},
}));
vi.mock('#lib/server/streaming/relay.js', () => ({
	startStreamingRelay: async (opts: unknown) => {
		mocks.relayCalls.push(opts);
		return new ReadableStream();
	},
}));

import { POST } from '../../src/routes/api/conversations/[id]/tool-approval/+server';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage } from '#lib/server/db/queries/messages.js';
import { getInFlightEntries, resetInFlight } from '#lib/server/streaming/in-flight.js';

function toolDef(name: string, description = name): OpenAIToolDefinition {
	return {
		type: 'function',
		function: { name, description, parameters: { type: 'object', properties: {} } },
	};
}

/** user → assistant(tool_call) → tool(pending_approval). */
function seedPendingApproval(): { conversationId: string; userId: string } {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'mock',
		modelId: 'mock::mock-chat',
		modelKind: 'chat',
	});
	let parent: string | null = null;
	const add = (
		role: 'user' | 'assistant' | 'tool',
		parts: Parameters<typeof appendMessage>[0]['parts'],
	) => {
		const m = appendMessage({
			conversationId: conv.id,
			parentMessageId: parent,
			role,
			parts,
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
		});
		parent = m.id;
		return m;
	};
	add('user', [{ type: 'text', text: 'look it up' }]);
	add('assistant', [
		{ type: 'tool_call', toolCallId: 'call_1', toolName: 'mcp__srv__lookup', arguments: '{}' },
	]);
	add('tool', [
		{ type: 'tool_result', toolCallId: 'call_1', result: '', status: 'pending_approval' },
	]);
	return { conversationId: conv.id, userId: u.id };
}

function approve(
	conversationId: string,
	userId: string,
	decisions: Array<{ toolCallId: string; action: string }> = [
		{ toolCallId: 'call_1', action: 'allow' },
	],
) {
	const url = new URL(`http://x/api/conversations/${conversationId}/tool-approval`);
	const request = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ decisions }),
	});
	return POST({
		locals: { user: { id: userId } },
		params: { id: conversationId },
		request,
		url,
	} as unknown as Parameters<typeof POST>[0]);
}

const names = (tools: OpenAIToolDefinition[] | undefined) =>
	(tools ?? []).map((t) => t.function.name);

beforeEach(() => {
	mocks.testDb = createTestDb();
	mocks.toolDefs = [];
	mocks.relayCalls = [];
	mocks.execute = async () => {};
	mocks.executions = 0;
});
afterEach(() => {
	resetInFlight();
	closeTestDb();
});

describe('POST /tool-approval — tools[] matches the send path', () => {
	it('dedupes a base/activation-seed collision on the first resumed request', async () => {
		// The collision dedupeToolDefs exists for: a tool activated on an earlier
		// turn whose server has since stopped deferring it, so the shared context
		// advertises it twice. The send route dedupes at assignment; so must this.
		mocks.toolDefs = [
			toolDef('mcp__srv__lookup'),
			toolDef('web_search'),
			toolDef('mcp__srv__lookup'),
		];
		const { conversationId, userId } = seedPendingApproval();

		const res = await approve(conversationId, userId);

		expect(res.status).toBe(200);
		const [opts] = mocks.relayCalls as RelayOpts[];
		expect(names(opts.requestBody.tools)).toEqual(['mcp__srv__lookup', 'web_search']);
	});

	it('keeps the rebuilt per-iteration request deduped too', async () => {
		mocks.toolDefs = [toolDef('web_search'), toolDef('web_search')];
		const { conversationId, userId } = seedPendingApproval();

		await approve(conversationId, userId);

		const [opts] = mocks.relayCalls as RelayOpts[];
		const rebuilt = await opts.rebuildRequestBody({ activatedToolNames: [] });
		expect(names(rebuilt.tools)).toEqual(['web_search']);
	});
});

describe('POST /tool-approval — a pending call runs at most once', () => {
	it('executes a tool call named twice in one body once', async () => {
		const s = seedPendingApproval();
		await approve(s.conversationId, s.userId, [
			{ toolCallId: 'call_1', action: 'allow' },
			{ toolCallId: 'call_1', action: 'allow' },
		]);
		expect(mocks.executions).toBe(1);
	});

	it('executes once when two approvals for the same call overlap', async () => {
		// A second tab, or a retry, posting while the first approval's tool is
		// still running. The pending row only stops being pending once the
		// result is written, so without a claim both requests would run it.
		const s = seedPendingApproval();
		const waiting: Array<() => void> = [];
		mocks.execute = () => new Promise<void>((r) => waiting.push(r));

		const first = approve(s.conversationId, s.userId);
		await vi.waitFor(() => expect(mocks.executions).toBe(1));
		const second = Promise.resolve(approve(s.conversationId, s.userId)).then(
			() => 'ok',
			(e: { status?: number }) => e.status,
		);
		// Give the second request time to reach the pending row while the
		// first is still executing.
		await new Promise((r) => setTimeout(r, 50));
		for (const r of waiting) r();
		await first;
		expect(await second).toBe(409);
		expect(mocks.executions).toBe(1);
	});
});

describe('POST /tool-approval — the resumed turn is registered like a sent one', () => {
	it('records the conversation model on its in-flight entry, and answers as SSE', async () => {
		const { conversationId, userId } = seedPendingApproval();
		const res = await approve(conversationId, userId);
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(getInFlightEntries(conversationId)).toEqual([
			expect.objectContaining({ modelKind: 'chat', modelId: 'mock::mock-chat' }),
		]);
	});
});

describe('POST /tool-approval — resuming a scheduled run', () => {
	async function seedScheduledPending(runState: 'needs_input' | 'done') {
		const { createScheduledTask, insertScheduledRun, updateScheduledRun } =
			await import('#lib/server/db/queries/scheduled-tasks.js');
		const { conversations } = await import('#lib/server/db/schema.js');
		const { eq } = await import('drizzle-orm');
		const seeded = seedPendingApproval();
		const task = createScheduledTask(
			seeded.userId,
			{
				name: 'Brief',
				prompt: 'p',
				modelId: 'mock::mock-chat',
				customModelId: null,
				systemPrompt: null,
				parameters: null,
				cadence: { kind: 'daily', time: '07:00', days: [1] },
				timezone: 'UTC',
				toolPolicy: { allowed: [], ask: ['mcp__srv__lookup'], memoryWrites: false },
				disabledFeatures: [],
				deadlineMinutes: 60,
				enabled: true,
			},
			1,
		);
		mocks.testDb
			.update(conversations)
			.set({ scheduleId: task.id })
			.where(eq(conversations.id, seeded.conversationId))
			.run();
		const run = insertScheduledRun({
			scheduleId: task.id,
			userId: seeded.userId,
			slotAt: 1,
			trigger: 'schedule',
			state: 'queued',
		})!;
		updateScheduledRun(run.id, { state: runState, conversationId: seeded.conversationId });
		return { ...seeded, task, runId: run.id };
	}

	it('settles the run when the resumed turn ends', async () => {
		const { conversationId, userId, task, runId } = await seedScheduledPending('needs_input');

		const res = await approve(conversationId, userId);
		expect(res.status).toBe(200);
		const [opts] = mocks.relayCalls as Array<{ onOutcome?: (o: unknown) => void }>;
		opts.onOutcome?.({ kind: 'done', assistantMessageId: 'a1' });

		const { listScheduledRuns } = await import('#lib/server/db/queries/scheduled-tasks.js');
		expect(listScheduledRuns(task.id, userId, 1)[0]).toMatchObject({ id: runId, state: 'done' });
	});

	it('“Allow for this schedule” runs the call and moves the tool to allowed', async () => {
		const { conversationId, userId, task } = await seedScheduledPending('needs_input');

		await approve(conversationId, userId, [{ toolCallId: 'call_1', action: 'allow_schedule' }]);

		expect(mocks.executions).toBe(1);
		const { getScheduledTask } = await import('#lib/server/db/queries/scheduled-tasks.js');
		expect(getScheduledTask(task.id, userId)?.toolPolicy).toEqual({
			allowed: ['mcp__srv__lookup'],
			ask: [],
			memoryWrites: false,
		});
	});

	it('“Never for this schedule” rejects the call and stops offering the tool', async () => {
		const { conversationId, userId, task } = await seedScheduledPending('needs_input');

		await approve(conversationId, userId, [{ toolCallId: 'call_1', action: 'deny_schedule' }]);

		expect(mocks.executions).toBe(0);
		const { getScheduledTask } = await import('#lib/server/db/queries/scheduled-tasks.js');
		expect(getScheduledTask(task.id, userId)?.toolPolicy).toEqual({
			allowed: [],
			ask: [],
			memoryWrites: false,
		});
	});

	it('reads the schedule actions as plain allow / reject once the schedule is gone', async () => {
		const { conversationId, userId } = seedPendingApproval();
		const res = await approve(conversationId, userId, [
			{ toolCallId: 'call_1', action: 'allow_schedule' },
		]);
		expect(res.status).toBe(200);
		expect(mocks.executions).toBe(1);
	});

	it('treats a later approval in a finished run’s conversation as an ordinary chat turn', async () => {
		const { conversationId, userId } = await seedScheduledPending('done');

		await approve(conversationId, userId);

		const [opts] = mocks.relayCalls as Array<{ onOutcome?: unknown }>;
		expect(opts.onOutcome).toBeUndefined();
	});
});
