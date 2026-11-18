/**
 * Cross-user isolation at the ROUTE layer: a signed-in intruder calling every
 * id-addressed endpoint with a victim's ids gets nothing — no byte of the
 * victim's data in the response, no change to any row, and an error status.
 * The exception is the few idempotent routes that answer a foreign id with the
 * same empty result a nonexistent one gets (SCOPED_EMPTY, each with a reason);
 * they still must leak nothing and change nothing.
 *
 * CLAUDE.md's multi-user invariant is "every query scopes by user_id", and the
 * query modules test that. But a route can still look a resource up by id with
 * one helper and then act on it with another, or check the conversation and
 * forget the message belongs to it. Per-route tests cover the routes someone
 * thought to test; this walks all of them, so a new `[id]` route is covered by
 * default (the route list is read from disk, and an unmapped param fails).
 *
 * Global resources addressed by id — MCP servers (instance config), trusted
 * tools (keyed by tool name within the caller's own prefs), OAuth providers,
 * and the admin routes (403 for a non-admin, covered by the guard sweep) — are
 * out of scope and listed below.
 */
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { is, Table } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB, root: '' }));
vi.mock('#lib/server/env.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/env.js')>()),
	mediaDir: () => mocks.root,
	derivedDir: () => mocks.root,
}));
// The intruder's own conversation needs a resolvable model, or the send route
// refuses it ("no valid model") before it ever looks at a message id.
vi.mock('#lib/server/endpoints/registry.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/endpoints/registry.js')>()),
	getEndpoint: (id: string) =>
		id === 'e' ? ({ id: 'e', baseUrl: 'http://127.0.0.1:9/v1' } as never) : undefined,
}));

import * as schema from '#lib/server/db/schema.js';
import { createSession, validateSessionToken } from '#lib/server/auth/session.js';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage } from '#lib/server/db/queries/messages.js';
import { insertMedia, linkMessageMedia, trashMediaForUser } from '#lib/server/db/queries/media.js';
import { insertMessageImage } from '#lib/server/db/queries/message-images.js';
import { upsertPushSubscription } from '#lib/server/db/queries/push-subscriptions.js';
import { getDb } from '#lib/server/db/client.js';
import { createCustomModel } from '#lib/server/db/queries/custom-models.js';
import { createMemory } from '#lib/server/db/queries/memories.js';
import { createPromptSnippet } from '#lib/server/db/queries/prompt-snippets.js';
import { createSkill } from '#lib/server/db/queries/skills.js';
import { createScheduledTask } from '#lib/server/db/queries/scheduled-tasks.js';
import { insertCredential } from '#lib/server/db/queries/passkey.js';
import { getMediaStore } from '#lib/server/media/disk-store.js';
import { createUserMessage } from '#lib/server/messages/create-user-message.js';
import { POST as bulkDelete } from '../../src/routes/api/media/bulk-delete/+server';
import { POST as trashRestore } from '../../src/routes/api/media/trash/restore/+server';
import { POST as trashPurge } from '../../src/routes/api/media/trash/purge/+server';
import { GET as unitMembers } from '../../src/routes/api/media/unit-members/+server';
import { DELETE as pushUnsubscribe } from '../../src/routes/api/push/subscribe/+server';
import { PUT as presetAvatar } from '../../src/routes/api/custom-models/[id]/avatar/+server';
import { GET as earlierMessages } from '../../src/routes/api/conversations/[id]/messages/+server';
import { GET as photoState } from '../../src/routes/api/conversations/[id]/photos/+server';

const ROUTES = join(__dirname, '../../src/routes');

/** Routes that answer a foreign id with a 2xx EMPTY result by design. */
const SCOPED_EMPTY: Record<string, string> = {
	'/api/conversations/[id]/fanout DELETE': 'idempotent clear; "no parked fan-out here" is the goal',
	'/api/conversations/[id]/media GET': "lists media in the caller's conversation; none match",
	'/api/conversations/[id]/orphan-media GET': 'pre-delete count; zero for a conversation not yours',
	'/api/media/[id]/conversations GET': "lists the caller's conversations that use a media id",
	'/api/user/prompt-snippets/[id]/use POST': 'fire-and-forget usage bump, scoped by user',
};

/** Routes that refuse EVERY caller with the same status, before looking at
 *  any id: retired endpoints kept so a stale tab gets a reload hint. */
const CONSTANT_REFUSAL: Record<string, number> = {
	'/api/conversations/[id]/avatar/generate POST': 409,
	'/api/conversations/[id]/avatar/pick POST': 409,
	'/api/conversations/[id]/avatar/prepare POST': 409,
};

/** Routes that validate their body as exactly one of several shapes: one sweep
 *  case per shape, so each branch's ownership check is reached. */
const BODY_VARIANTS: Record<string, Array<Record<string, unknown>>> = {
	'/api/conversations/[id] PATCH': [
		{ archived: true },
		{ title: 'pwned' },
		{ disabledFeatures: ['web'] },
	],
};

const OUT_OF_SCOPE = [
	/^\/api\/admin\//,
	/^\/api\/auth\/oauth\/\[provider\]/,
	/^\/api\/mcp\/servers\/\[id\]/,
	/^\/api\/user\/trusted-tools\/\[name\]/,
];

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : e.name === '+server.ts' ? [join(dir, e.name)] : [],
	);
}

/** The message / media id fields a conversation-scoped write reads from its body. */
function bodyIdFields(t: { file: string; route: string; method: string }): string[] {
	if (!t.route.startsWith('/api/conversations/[id]')) return [];
	if (!['POST', 'PUT', 'PATCH'].includes(t.method)) return [];
	const src = readFileSync(t.file, 'utf8');
	const fields = src.matchAll(/body\??\.(\w*MessageId|messageId|mediaId|\w*MediaIds)\b/g);
	return [...new Set([...fields].map((m) => m[1]))].sort();
}

const routeOf = (file: string) => '/' + relative(ROUTES, join(file, '..')).split(sep).join('/');

const targets = walk(ROUTES)
	.map((file) => ({ file, route: routeOf(file) }))
	.filter(({ route }) => route.includes('[') && !OUT_OF_SCOPE.some((re) => re.test(route)))
	.flatMap(({ file, route }) => {
		const src = readFileSync(file, 'utf8');
		return [
			...src.matchAll(/export\s+(?:const|(?:async\s+)?function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g),
		].map((m) => ({ file, route, method: m[1] }));
	})
	.flatMap((t) =>
		(BODY_VARIANTS[`${t.route} ${t.method}`] ?? [null]).map((variant) => ({ ...t, variant })),
	)
	.flatMap((t) => [
		{ ...t, crossConversation: false, bodyField: null as string | null },
		// The sharper IDOR: the intruder's OWN conversation, so the conversation
		// ownership check passes, carrying a victim id — in the path, or in ONE
		// body field at a time, so an earlier field's refusal can't mask a later
		// field's missing check.
		...(t.route.includes('[messageId]') || t.route.includes('[photoId]')
			? [{ ...t, crossConversation: true, bodyField: null }]
			: []),
		...bodyIdFields(t).map((bodyField) => ({ ...t, crossConversation: true, bodyField })),
	])
	.sort((a, b) =>
		`${a.route} ${a.method} ${a.bodyField ?? ''} ${JSON.stringify(a.variant)}`.localeCompare(
			`${b.route} ${b.method} ${b.bodyField ?? ''} ${JSON.stringify(b.variant)}`,
		),
	);

/** Body fields that only matter inside a fan-out dispatch, which this sweep
 *  doesn't set up. Listed so a new body id field fails loudly instead. */
const UNREACHED_BODY_FIELDS: Record<string, string> = {
	'/api/conversations/[id]/messages POST inputMediaIds':
		'read only for a fanoutBranch dispatch; the shared user message is checked first',
};

interface Victim {
	conversationId: string;
	messageId: string;
	mediaId: string;
	customModelId: string;
	memoryId: string;
	snippetId: string;
	skillId: string;
	passkeyId: string;
	sessionId: string;
	scheduleId: string;
	photoId: string;
	trashedMediaId: string;
	pushEndpoint: string;
}

let victim: Victim;
let intruder: NonNullable<App.Locals['user']>;
/** A conversation the intruder really owns, to pair with the victim's message id. */
let intruderConversationId: string;
/** A preset the intruder really owns, to pair with the victim's media id. */
let intruderPresetId: string;
/** The newest message of the intruder's conversation, a valid paging cursor. */
let intruderReplyId: string;

/** Which victim id a route's `[id]` refers to, by route prefix. */
function paramsFor(route: string, crossConversation: boolean): Record<string, string> {
	const idFor: Array<[RegExp, keyof Victim]> = [
		[/^\/api\/conversations\/\[id\]/, 'conversationId'],
		[/^\/api\/media\/\[id\]/, 'mediaId'],
		[/^\/api\/custom-models\/\[id\]/, 'customModelId'],
		[/^\/api\/user\/memories\/\[id\]/, 'memoryId'],
		[/^\/api\/user\/prompt-snippets\/\[id\]/, 'snippetId'],
		[/^\/api\/user\/skills\/\[id\]/, 'skillId'],
		[/^\/api\/auth\/passkey\/\[id\]/, 'passkeyId'],
		[/^\/api\/auth\/sessions\/\[id\]/, 'sessionId'],
		[/^\/api\/user\/schedules\/\[id\]/, 'scheduleId'],
	];
	const hit = idFor.find(([re]) => re.test(route));
	if (!hit) throw new Error(`no victim id mapped for ${route} — add it to paramsFor`);
	const params: Record<string, string> = { id: victim[hit[1]] };
	if (route.includes('[messageId]')) params.messageId = victim.messageId;
	if (route.includes('[photoId]')) params.photoId = victim.photoId;
	if (crossConversation) params.id = intruderConversationId;
	return params;
}

/** A body shaped enough to get past validation to the ownership check.
 *
 *  Every field a swept route validates must appear here, or that route's entry in
 *  the sweep passes on a 400 from its own input check and never reaches the
 *  ownership predicate this file exists to verify — a guard that looks green while
 *  guarding nothing (`favorite` is here for `PATCH /api/media/[id]`). */
function bodyFor(route: string, method: string): unknown {
	if (method === 'GET' || method === 'DELETE') return undefined;
	return {
		title: 'pwned',
		favorite: true,
		name: 'pwned',
		body: 'pwned',
		content: 'pwned',
		archived: true,
		disabled: true,
		private: false,
		mediaId: victim.mediaId,
		messageId: victim.messageId,
		parentMessageId: victim.messageId,
		editedMessageId: victim.messageId,
		regenerateFromMessageId: victim.messageId,
		sourceMessageId: victim.messageId,
		attachedMediaIds: [victim.mediaId],
		inputMediaIds: [victim.mediaId],
		toolCallId: 'call_1',
		decisions: [{ toolCallId: 'call_1', action: 'allow' }],
		shown: true,
		// A texting photo's number, which its route validates first.
		index: 0,
		decision: 'deny',
		approved: false,
		text: 'pwned',
		parts: [{ type: 'text', text: 'pwned' }],
		enabled: false,
		// A scheduled task's PUT validates all of these before its ownership check.
		prompt: 'pwned',
		modelId: 'e::m',
		cadence: { kind: 'daily', time: '07:00', days: [1] },
		timezone: 'UTC',
		route,
	};
}

/** A body carrying exactly one victim id, plus what the routes need to reach the
 *  check: some text, and the intruder conversation's own (resolvable) model. */
function crossBody(field: string): Record<string, unknown> {
	const value = field.endsWith('MediaIds')
		? [victim.mediaId]
		: field === 'mediaId'
			? victim.mediaId
			: victim.messageId;
	return { text: 'hello', modelId: 'e::m', index: 0, [field]: value };
}

/** Every row of every table as JSON, keyed by table, so "the victim's data didn't
 *  change" is literal. Sessions drop only `last_seen_at` (bookkeeping, not data),
 *  so revoking a victim's session still shows up. */
function rows(): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const t of Object.values(schema)) {
		if (!is(t, Table)) continue;
		const name = getTableConfig(t as Parameters<typeof getTableConfig>[0]).name;
		const all = mocks.testDb
			.select()
			.from(t as never)
			.all() as Array<Record<string, unknown>>;
		out.set(
			name,
			all.map((r) => {
				const row = { ...r };
				if (name === 'sessions') delete row.lastSeenAt;
				return JSON.stringify(row, (_k, v: unknown) =>
					v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
				);
			}),
		);
	}
	return out;
}

function snapshot(): string {
	return JSON.stringify([...rows()]);
}

/** Rows that appeared or disappeared (a changed row is both) between two reads. */
function changedRows(before: Map<string, string[]>, after: Map<string, string[]>): string[] {
	const out: string[] = [];
	for (const [table, now] of after) {
		const was = new Set(before.get(table) ?? []);
		const current = new Set(now);
		for (const r of now) if (!was.has(r)) out.push(`+${table} ${r}`);
		for (const r of was) if (!current.has(r)) out.push(`-${table} ${r}`);
	}
	return out;
}

beforeAll(async () => {
	mocks.testDb = createTestDb();
	mocks.root = mkdtempSync(join(tmpdir(), 'gs-idor-'));
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});

	const v = seedUser();
	const conv = createConversation({
		userId: v.id,
		endpointId: 'e',
		modelId: 'm',
		modelKind: null,
		title: 'victim chat',
	});
	const user = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'victim secret' }],
	} as Parameters<typeof appendMessage>[0]);
	const assistant = appendMessage({
		conversationId: conv.id,
		parentMessageId: user.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'victim reply' }],
	} as Parameters<typeof appendMessage>[0]);
	const ref = await getMediaStore().put({
		bytes: Buffer.from('victim image'),
		contentType: 'image/png',
		kind: 'image',
	});
	const m = insertMedia({
		userId: v.id,
		storagePath: ref.storagePath,
		contentType: 'image/png',
		byteSize: 12,
		kind: 'image',
		sourceEndpointId: null,
		sourceModel: null,
		promptExcerpt: 'victim prompt',
	});
	// Linked, so an unscoped media or conversation lookup would return something.
	linkMessageMedia(assistant.id, m.id);
	// A version of a photo on the reply, for the photo routes' [photoId].
	getDb().transaction((tx) =>
		insertMessageImage(tx, {
			id: 'victim-photo',
			userId: v.id,
			conversationId: conv.id,
			messageId: assistant.id,
			kind: 'photo',
			markerIndex: 0,
			mediaId: m.id,
			modelId: 'e::img',
			error: null,
			shownAt: null,
			comparisonId: null,
			createdAt: 1,
		}),
	);
	// A tool call paused on approval, below the reply, for the approval route.
	const call = appendMessage({
		conversationId: conv.id,
		parentMessageId: assistant.id,
		role: 'assistant',
		parts: [
			{ type: 'tool_call', toolCallId: 'call_1', toolName: 'mcp__srv__lookup', arguments: '{}' },
		],
	} as Parameters<typeof appendMessage>[0]);
	appendMessage({
		conversationId: conv.id,
		parentMessageId: call.id,
		role: 'tool',
		parts: [{ type: 'tool_result', toolCallId: 'call_1', result: '', status: 'pending_approval' }],
	} as Parameters<typeof appendMessage>[0]);
	const trashedRef = await getMediaStore().put({
		bytes: Buffer.from('victim trashed image'),
		contentType: 'image/png',
		kind: 'image',
	});
	const trashed = insertMedia({
		userId: v.id,
		storagePath: trashedRef.storagePath,
		contentType: 'image/png',
		byteSize: 20,
		kind: 'image',
		sourceEndpointId: null,
		sourceModel: null,
		promptExcerpt: 'victim trashed prompt',
	});
	trashMediaForUser(trashed.id, v.id);
	const pushEndpoint = 'https://push.example.test/victim-device';
	upsertPushSubscription({
		userId: v.id,
		sessionId: null,
		endpoint: pushEndpoint,
		p256dh: 'victim-key',
		auth: 'victim-auth',
	});
	insertCredential({
		id: 'victim-passkey',
		userId: v.id,
		publicKey: new Uint8Array([1, 2, 3]),
		counter: 0,
		transports: null,
		backedUp: false,
		deviceType: 'singleDevice',
		name: 'victim key',
	});
	const victimSession = createSession(v.id);
	victim = {
		conversationId: conv.id,
		messageId: assistant.id,
		mediaId: m.id,
		customModelId: createCustomModel({
			userId: v.id,
			name: 'victim model',
			description: null,
			baseEndpointId: 'e',
			baseModelId: 'm',
			systemPrompt: 'victim system prompt',
			parameters: null,
		}).id,
		memoryId: createMemory(v.id, 'victim memory').id,
		snippetId: createPromptSnippet({ userId: v.id, name: 'victim snippet', body: 'secret' }).id,
		skillId: createSkill({
			userId: v.id,
			name: 'victim-skill',
			description: 'd',
			storagePath: 'skills/victim',
		}).id,
		passkeyId: 'victim-passkey',
		photoId: 'victim-photo',
		trashedMediaId: trashed.id,
		pushEndpoint,
		sessionId: validateSessionToken(victimSession.token)!.sessionId,
		scheduleId: createScheduledTask(
			v.id,
			{
				name: 'victim schedule',
				prompt: 'victim secret prompt',
				modelId: 'e::m',
				customModelId: null,
				systemPrompt: null,
				parameters: null,
				cadence: { kind: 'daily', time: '07:00', days: [1] },
				timezone: 'UTC',
				toolPolicy: { allowed: [], ask: [], memoryWrites: false },
				disabledFeatures: [],
				deadlineMinutes: 60,
				enabled: true,
			},
			Date.now() + 86_400_000,
		).id,
	};

	const i = seedUser();
	intruder = validateSessionToken(createSession(i.id).token)!.user;
	intruderConversationId = createConversation({
		userId: i.id,
		endpointId: 'e',
		modelId: 'e::m',
		modelKind: null,
	}).id;
	const own = appendMessage({
		conversationId: intruderConversationId,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'mine' }],
	} as Parameters<typeof appendMessage>[0]);
	intruderReplyId = appendMessage({
		conversationId: intruderConversationId,
		parentMessageId: own.id,
		role: 'assistant',
		parts: [{ type: 'text', text: 'my reply' }],
	} as Parameters<typeof appendMessage>[0]).id;
	intruderPresetId = createCustomModel({
		userId: i.id,
		name: 'my preset',
		description: null,
		baseEndpointId: 'e',
		baseModelId: 'm',
		systemPrompt: null,
		parameters: null,
	}).id;
});

afterAll(() => {
	closeTestDb();
	rmSync(mocks.root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('an intruder addressing a victim’s resources by id', () => {
	const modules = import.meta.glob<Record<string, unknown>>('../../src/routes/api/**/+server.ts');

	it('covers id-addressed routes', () => {
		expect(targets.length).toBeGreaterThan(40);
		const live = new Set(targets.map((t) => `${t.route} ${t.method}`));
		expect(Object.keys(SCOPED_EMPTY).filter((k) => !live.has(k))).toEqual([]);
		expect(Object.keys(CONSTANT_REFUSAL).filter((k) => !live.has(k))).toEqual([]);
		expect(Object.keys(BODY_VARIANTS).filter((k) => !live.has(k))).toEqual([]);
		const liveFields = new Set(targets.map((t) => `${t.route} ${t.method} ${t.bodyField}`));
		expect(Object.keys(UNREACHED_BODY_FIELDS).filter((k) => !liveFields.has(k))).toEqual([]);
	});

	it.each(
		targets.map(
			(t) =>
				[
					`${t.route} ${t.method}${t.variant ? ` ${JSON.stringify(t.variant)}` : ''}${t.crossConversation ? ` (own conversation, victim ${t.bodyField ?? 'path id'})` : ''}`,
					t,
				] as const,
		),
	)('%s', async (_name, t) => {
		const before = rows();
		const key = '../../src/routes/' + relative(ROUTES, t.file).split(sep).join('/');
		const fn = (await modules[key]())[t.method] as (e: RequestEvent) => unknown;
		const params = paramsFor(t.route, t.crossConversation);
		const path = t.route.replace(/\[(\w+)\]/g, (_m, p: string) => {
			if (!params[p]) throw new Error(`no victim id mapped for [${p}] — add it to paramsFor`);
			return params[p];
		});
		const url = new URL(path, 'https://chat.example.test');
		const bodyKey = `${t.route} ${t.method} ${t.bodyField}`;
		if (bodyKey in UNREACHED_BODY_FIELDS) return;
		const body = t.bodyField ? crossBody(t.bodyField) : (t.variant ?? bodyFor(t.route, t.method));
		const event = {
			url,
			params,
			route: { id: t.route },
			locals: { user: intruder, sessionId: null },
			cookies: { get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] },
			request: new Request(url, {
				method: t.method,
				headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			getClientAddress: () => '203.0.113.1',
			setHeaders: () => {},
			fetch,
			platform: undefined,
			isDataRequest: false,
			isSubRequest: false,
		} as unknown as RequestEvent;

		let status: number;
		let text: string;
		try {
			const res = (await fn(event)) as Response;
			status = res.status;
			text = await res.text();
		} catch (e) {
			if (!(e && typeof e === 'object' && 'status' in e)) throw e;
			status = Number(e.status);
			text = JSON.stringify((e as { body?: unknown }).body ?? '');
		}
		expect(text).not.toMatch(/victim/);
		if (t.crossConversation) {
			// The intruder may legitimately change their own conversation here, so
			// what's checked is that nothing touched involves the victim: no victim
			// row altered or removed, and no new row pointing at a victim id.
			const victimIds: string[] = Object.values(victim as unknown as Record<string, string>);
			const touched = changedRows(before, rows()).filter((r) =>
				victimIds.some((id) => r.includes(id)),
			);
			expect(touched).toEqual([]);
			// And the refusal is the id check itself, not some earlier validation
			// that happened to stop the request first.
			expect([400, 404], text).toContain(status);
			expect(text).toMatch(/not found/i);
			// The intruder owns this conversation, so it's never the thing refused.
			expect(text).not.toMatch(/conversation not found/i);
		} else {
			expect(snapshot()).toBe(JSON.stringify([...before]));
			const key = `${t.route} ${t.method}`;
			if (key in SCOPED_EMPTY) expect(status).toBeLessThan(300);
			else if (key in CONSTANT_REFUSAL) expect(status, text).toBe(CONSTANT_REFUSAL[key]);
			else {
				// The ownership refusal itself — not a validation 400 that fired
				// before the handler ever looked the id up.
				expect([400, 404], text).toContain(status);
				expect(text).toMatch(/not found/i);
			}
		}
	});
});

describe('an intruder attaching a victim’s media to their own message', () => {
	// Ids in a request BODY are the other way in: the conversation is genuinely
	// the intruder's, so only the per-media ownership check stands between them
	// and a message that renders (and sends upstream) someone else's image.
	it('is refused before anything is written', () => {
		const before = snapshot();
		let status = 0;
		try {
			createUserMessage({
				conversationId: intruderConversationId,
				userId: intruder.id,
				text: 'look at this',
				attachedMediaIds: [victim.mediaId],
				activeLeafMessageId: null,
				existingTitle: null,
			});
		} catch (e) {
			status = e && typeof e === 'object' && 'status' in e ? Number(e.status) : -1;
		}
		expect(status).toBe(400);
		expect(snapshot()).toBe(before);
	});
});

/**
 * The id-addressed access the walk above can't see: routes with no path
 * param that take ids in the body, a victim id in the body of a resource the
 * intruder really owns outside the conversations subtree, and victim ids in
 * the query string. Each must answer as if the id didn't exist and change
 * nothing.
 */
describe('an intruder passing a victim’s ids outside the path', () => {
	type Handler = (e: RequestEvent) => unknown;

	async function call(
		fn: Handler,
		opts: { method: string; path: string; params?: Record<string, string>; body?: unknown },
	): Promise<{ status: number; text: string }> {
		const url = new URL(opts.path, 'https://chat.example.test');
		const event = {
			url,
			params: opts.params ?? {},
			locals: { user: intruder, sessionId: null },
			request: new Request(url, {
				method: opts.method,
				headers: { 'content-type': 'application/json' },
				body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			}),
			setHeaders: () => {},
		} as unknown as RequestEvent;
		try {
			const res = (await fn(event)) as Response;
			return { status: res.status, text: await res.text() };
		} catch (e) {
			if (!(e && typeof e === 'object' && 'status' in e)) throw e;
			return { status: Number(e.status), text: JSON.stringify((e as { body?: unknown }).body) };
		}
	}

	/** Calls the handler and asserts no row changed and nothing of the victim's leaked. */
	async function refused(fn: Handler, opts: Parameters<typeof call>[1]) {
		const before = snapshot();
		const res = await call(fn, opts);
		expect(res.text).not.toMatch(/victim/);
		expect(snapshot()).toBe(before);
		return res;
	}

	it('bulk-delete deletes none of a victim’s media', async () => {
		const res = await refused(bulkDelete as Handler, {
			method: 'POST',
			path: '/api/media/bulk-delete',
			body: { ids: [victim.mediaId] },
		});
		expect(JSON.parse(res.text)).toEqual({ deleted: 0 });
	});

	it('trash restore restores none of a victim’s trashed media', async () => {
		const res = await refused(trashRestore as Handler, {
			method: 'POST',
			path: '/api/media/trash/restore',
			body: { ids: [victim.trashedMediaId] },
		});
		expect(JSON.parse(res.text)).toEqual({ restored: 0 });
	});

	it.each([
		['by id', () => ({ ids: [victim.trashedMediaId] })],
		['by cutoff', () => ({ deletedUpTo: Date.now() + 60_000 })],
	])('trash purge %s purges none of a victim’s trash', async (_label, body) => {
		const res = await refused(trashPurge as Handler, {
			method: 'POST',
			path: '/api/media/trash/purge',
			body: body(),
		});
		expect(JSON.parse(res.text)).toEqual({ purged: 0 });
	});

	it('unsubscribing a victim’s push endpoint is refused', async () => {
		const res = await refused(pushUnsubscribe as Handler, {
			method: 'DELETE',
			path: '/api/push/subscribe',
			body: { endpoint: victim.pushEndpoint },
		});
		expect(res.status).toBe(404);
	});

	it('the intruder’s own preset can’t take a victim’s image as its avatar', async () => {
		const res = await refused(presetAvatar as Handler, {
			method: 'PUT',
			path: `/api/custom-models/${intruderPresetId}/avatar`,
			params: { id: intruderPresetId },
			body: { mediaId: victim.mediaId },
		});
		expect(res.status).toBe(400);
		expect(res.text).toMatch(/media not found/i);
	});

	it('unit-members keyed by a victim’s conversation lists nothing', async () => {
		const res = await refused(unitMembers as Handler, {
			method: 'GET',
			path: `/api/media/unit-members?key=${victim.conversationId}`,
		});
		expect(JSON.parse(res.text)).toEqual({ items: [] });
	});

	it.each(['before', 'through'])(
		'paging the intruder’s own conversation with a victim message as %s is refused',
		async (param) => {
			const query =
				param === 'before'
					? `before=${victim.messageId}`
					: `before=${intruderReplyId}&through=${victim.messageId}`;
			const res = await refused(earlierMessages as Handler, {
				method: 'GET',
				path: `/api/conversations/${intruderConversationId}/messages?${query}`,
				params: { id: intruderConversationId },
			});
			expect(res.status).toBe(409);
		},
	);

	it('photo state for a victim’s reply, asked through the intruder’s conversation, is empty', async () => {
		const res = await refused(photoState as Handler, {
			method: 'GET',
			path: `/api/conversations/${intruderConversationId}/photos?messages=${victim.messageId}`,
			params: { id: intruderConversationId },
		});
		expect(res.status).toBe(200);
		const body = JSON.parse(res.text) as { developing: number; replies: Record<string, unknown> };
		expect(body.developing).toBe(0);
		expect(body.replies[victim.messageId]).toEqual({ images: [], developing: [] });
	});
});
