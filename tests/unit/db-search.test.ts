import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import { buildFtsQuery, searchConversations } from '$lib/server/db/queries/search';
import {
	createConversation,
	deleteConversation,
	renameConversation,
} from '$lib/server/db/queries/conversations';
import { appendMessage } from '$lib/server/db/queries/messages';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

function newConv(userId: string, title?: string) {
	return createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::x',
		modelKind: 'chat',
		title: title ?? null,
	});
}

function userText(convId: string, text: string, parent: string | null = null) {
	return appendMessage({
		conversationId: convId,
		parentMessageId: parent,
		role: 'user',
		parts: [{ type: 'text', text }],
	});
}

describe('buildFtsQuery', () => {
	it('returns null for empty / whitespace-only input', () => {
		expect(buildFtsQuery('')).toBeNull();
		expect(buildFtsQuery('   ')).toBeNull();
		expect(buildFtsQuery('\t\n')).toBeNull();
	});

	it('quotes each whitespace-separated token and AND-joins', () => {
		expect(buildFtsQuery('hello world')).toBe('"hello" "world"');
		expect(buildFtsQuery('  one  two   three  ')).toBe('"one" "two" "three"');
	});

	it('escapes embedded double quotes via FTS5 doubling', () => {
		expect(buildFtsQuery('foo"bar')).toBe('"foo""bar"');
	});

	it('neutralizes FTS5 operator characters by phrase-quoting', () => {
		// `*`, `(`, `^`, `:`, etc. inside phrase quotes are treated as
		// literal tokenizer input — no operator parsing happens.
		expect(buildFtsQuery('a* (b) ^c d:e')).toBe('"a*" "(b)" "^c" "d:e"');
	});
});

describe('searchConversations', () => {
	it('returns [] for an empty query without hitting the DB', () => {
		const u = seedUser();
		expect(searchConversations(u.id, '')).toEqual([]);
		expect(searchConversations(u.id, '   ')).toEqual([]);
	});

	it('finds a message body hit and returns a snippet with <mark> highlights', () => {
		const u = seedUser();
		const conv = newConv(u.id);
		userText(conv.id, 'the quick brown fox jumps over the lazy dog');
		const results = searchConversations(u.id, 'brown fox');
		expect(results).toHaveLength(1);
		const r = results[0];
		expect(r.conversationId).toBe(conv.id);
		expect(r.kind).toBe('message');
		expect(r.messageId).not.toBeNull();
		expect(r.snippet).toContain('<mark>');
		expect(r.snippet).toContain('brown');
	});

	it('finds a conversation title hit (no messageId on the result)', () => {
		const u = seedUser();
		const conv = newConv(u.id, 'Deep dive on regex performance');
		const results = searchConversations(u.id, 'regex');
		expect(results).toHaveLength(1);
		expect(results[0].conversationId).toBe(conv.id);
		expect(results[0].kind).toBe('title');
		expect(results[0].messageId).toBeNull();
		expect(results[0].conversationTitle).toBe('Deep dive on regex performance');
	});

	it('does not leak results across users', () => {
		const u1 = seedUser();
		const u2 = seedUser();
		const c1 = newConv(u1.id, 'My private notes');
		userText(c1.id, 'a secret about pineapple pizza');
		newConv(u2.id, 'Other person notes');
		expect(searchConversations(u2.id, 'pineapple')).toEqual([]);
		const ownResults = searchConversations(u1.id, 'pineapple');
		expect(ownResults).toHaveLength(1);
		expect(ownResults[0].conversationId).toBe(c1.id);
	});

	it('collapses multiple message hits in one conversation to a single row', () => {
		const u = seedUser();
		const conv = newConv(u.id, 'unrelated title');
		const root = userText(conv.id, 'first mention of widgets here');
		userText(conv.id, 'second mention of widgets too', root.id);
		userText(conv.id, 'third widgets reference', root.id);
		const results = searchConversations(u.id, 'widgets');
		// One row per conversation — even though there are three message
		// hits, the result list shows the conversation once.
		expect(results.filter((r) => r.conversationId === conv.id)).toHaveLength(1);
	});

	it('returns title and message hits together when a query matches both', () => {
		const u = seedUser();
		const a = newConv(u.id, 'Octopus facts');
		userText(a.id, 'unrelated body text');
		const b = newConv(u.id, 'Daily standup');
		userText(b.id, 'today we discussed the octopus migration plan');
		const results = searchConversations(u.id, 'octopus');
		const byConv = Object.fromEntries(results.map((r) => [r.conversationId, r]));
		expect(byConv[a.id]?.kind).toBe('title');
		expect(byConv[b.id]?.kind).toBe('message');
	});

	it('drops the search row when a message is deleted', () => {
		const u = seedUser();
		const conv = newConv(u.id);
		userText(conv.id, 'mention of zebra here');
		expect(searchConversations(u.id, 'zebra')).toHaveLength(1);
		// Cascade by deleting the conversation — exercises both the
		// messages_ad and conversations_ad triggers.
		deleteConversation(conv.id, u.id);
		expect(searchConversations(u.id, 'zebra')).toEqual([]);
	});

	it('reflects a conversation title rename via the update trigger', () => {
		const u = seedUser();
		const conv = newConv(u.id, 'original title with platypus');
		expect(searchConversations(u.id, 'platypus')).toHaveLength(1);
		renameConversation(conv.id, u.id, 'rewritten title');
		expect(searchConversations(u.id, 'platypus')).toEqual([]);
		expect(searchConversations(u.id, 'rewritten')).toHaveLength(1);
	});

	it('does not error on FTS5 special characters in the query', () => {
		const u = seedUser();
		const conv = newConv(u.id);
		userText(conv.id, 'simple body');
		// All of these would break a naive MATCH passthrough.
		expect(() => searchConversations(u.id, '"')).not.toThrow();
		expect(() => searchConversations(u.id, '* AND')).not.toThrow();
		expect(() => searchConversations(u.id, '(foo OR bar)')).not.toThrow();
		expect(() => searchConversations(u.id, 'NEAR(a b)')).not.toThrow();
		void conv;
	});

	it('HTML-escapes the snippet so user-supplied <script>-shaped text is safe to render', () => {
		const u = seedUser();
		const conv = newConv(u.id);
		userText(conv.id, 'attack vector: <script>alert(1)</script> dangerously');
		const results = searchConversations(u.id, 'dangerously');
		expect(results).toHaveLength(1);
		// Raw `<script>` must be escaped; the surrounding <mark> tags are
		// the only literal HTML in the snippet.
		expect(results[0].snippet).not.toContain('<script>');
		expect(results[0].snippet).toContain('&lt;script&gt;');
		// Match highlighting still works around the escaped text.
		expect(results[0].snippet).toMatch(/<mark>.*<\/mark>/);
	});

	it('escapes the conversation title even when it contains HTML', () => {
		const u = seedUser();
		newConv(u.id, '<img src=x onerror=evil()> chat about cats');
		const results = searchConversations(u.id, 'cats');
		expect(results).toHaveLength(1);
		expect(results[0].snippet).not.toContain('<img');
		expect(results[0].snippet).toContain('&lt;img');
	});

	it('ignores non-text message parts (image-only message has empty index row)', () => {
		const u = seedUser();
		const conv = newConv(u.id);
		appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'assistant',
			parts: [{ type: 'image', mediaId: 'fake-media-id' }],
		});
		// An image-only message indexes the empty string — searching for
		// anything content-bearing should yield no results from it.
		expect(searchConversations(u.id, 'image')).toEqual([]);
	});
});
