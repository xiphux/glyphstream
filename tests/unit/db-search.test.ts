import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

import { buildFtsQuery, searchConversations } from '#lib/server/db/queries/search.js';
import {
	createConversation,
	deleteConversation,
	renameConversation,
} from '#lib/server/db/queries/conversations.js';
import { appendMessage } from '#lib/server/db/queries/messages.js';
import { searchConversationsTool } from '#lib/server/tools/conversation-search.js';
import type { ToolExecution } from '#lib/server/tools/types.js';

beforeEach(() => {
	createTestDb();
});

afterEach(() => {
	closeTestDb();
});

function newConv(userId: string, title?: string, opts: { private?: boolean } = {}) {
	return createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::x',
		modelKind: 'chat',
		title: title ?? null,
		private: opts.private,
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

	it('includes private conversations by default (the sidebar sees all your history)', () => {
		const u = seedUser();
		const conv = newConv(u.id, 'Secret roleplay', { private: true });
		userText(conv.id, 'a private mention of quokkas');
		// No excludePrivate → the sidebar search still finds it.
		const results = searchConversations(u.id, 'quokkas');
		expect(results).toHaveLength(1);
		expect(results[0].conversationId).toBe(conv.id);
	});

	it('omits private conversations when excludePrivate is set (the tool path seal)', () => {
		const u = seedUser();
		const priv = newConv(u.id, 'Secret roleplay', { private: true });
		userText(priv.id, 'a private mention of narwhals');
		const normal = newConv(u.id, 'Normal chat');
		userText(normal.id, 'a public mention of narwhals');
		// The model-facing tool passes excludePrivate: the private chat's content
		// must not surface, but the normal one still does.
		const results = searchConversations(u.id, 'narwhals', { excludePrivate: true });
		expect(results).toHaveLength(1);
		expect(results[0].conversationId).toBe(normal.id);
	});

	it('excludePrivate also seals a private conversation’s TITLE hit', () => {
		const u = seedUser();
		newConv(u.id, 'platypus grooming diary', { private: true });
		// Title-only hit — still excluded on the tool path.
		expect(searchConversations(u.id, 'platypus', { excludePrivate: true })).toEqual([]);
		// ...but visible to the user's own sidebar search.
		expect(searchConversations(u.id, 'platypus')).toHaveLength(1);
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

/**
 * One long thread that mentions a name in about half its messages, beside
 * eight ordinary chats that mention it once. The limit is on conversations,
 * so the long thread's many hits must not crowd the others out.
 */
describe('a long thread that holds most of the hits', () => {
	const WORDS =
		'the of and to a in is it you that he was for on are with as his they be at one have this from or had by hot but some what there we can out other were all your when up use word how said an each she which do their time'.split(
			' ',
		);
	let seed = 12345;
	function rnd(): number {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	}
	function prose(words: number, mention: boolean): string {
		const out: string[] = [];
		for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
		if (mention) out.splice(Math.floor(rnd() * out.length), 0, 'Marisol');
		return out.join(' ');
	}
	function thread(convId: string, length: number, words: (i: number) => [number, boolean]) {
		let parent: string | null = null;
		for (let i = 0; i < length; i++) {
			const [n, mention] = words(i);
			parent = appendMessage({
				conversationId: convId,
				parentMessageId: parent,
				role: i % 2 ? 'assistant' : 'user',
				parts: [{ type: 'text', text: prose(n, mention) }],
			}).id;
		}
	}
	function build() {
		seed = 12345;
		const u = seedUser();
		const big = newConv(u.id);
		thread(big.id, 400, (i) => [
			i % 2 ? 40 + Math.floor(rnd() * 360) : 5 + Math.floor(rnd() * 35),
			rnd() < 0.5,
		]);
		const others: string[] = [];
		for (let c = 0; c < 8; c++) {
			const conv = newConv(u.id);
			thread(conv.id, 10, (j) => [j % 2 ? 150 + c * 30 : 20, j === 5]);
			others.push(conv.id);
		}
		return { u, big, others };
	}

	it('returns every matching conversation at the sidebar limit', () => {
		const { u, big, others } = build();
		const ids = searchConversations(u.id, 'marisol').map((h) => h.conversationId);
		expect(new Set(ids)).toEqual(new Set([big.id, ...others]));
	});

	it('returns every other matching conversation to the tool called from inside it', () => {
		const { u, big, others } = build();
		const r = searchConversationsTool.execute(
			{ query: 'marisol' },
			{
				userId: u.id,
				conversationId: big.id,
				signal: new AbortController().signal,
				disabledFeatures: [],
			},
		) as ToolExecution;
		const ids = (
			JSON.parse(r.content) as { results: Array<{ conversationId: string }> }
		).results.map((h) => h.conversationId);
		expect(new Set(ids)).toEqual(new Set(others));
	});

	it('keeps each conversation on its best-ranked snippet', () => {
		const { u, others } = build();
		const hit = searchConversations(u.id, 'marisol').find((h) => h.conversationId === others[0]);
		expect(hit?.snippet).toContain('<mark>Marisol</mark>');
		expect(hit?.kind).toBe('message');
	});
});
