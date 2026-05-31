import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	createConversation,
	getConversationFirstExchange,
	getConversationTitleSource,
	RenameValidationError,
	renameConversation,
	setConversationTitle,
	setConversationTitleIfFallback,
} from '$lib/server/db/queries/conversations';
import { appendMessage, setActiveLeafMessageId } from '$lib/server/db/queries/messages';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

describe('title_source state machine', () => {
	it('defaults to fallback on new conversations', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		expect(getConversationTitleSource(conv.id)).toBe('fallback');
	});

	it('setConversationTitle defaults source to fallback (preserves legacy callers)', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		setConversationTitle(conv.id, 'first-line preview');
		expect(getConversationTitleSource(conv.id)).toBe('fallback');
	});

	it('setConversationTitleIfFallback overwrites a fallback title', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
			title: 'preview…',
		});
		const ok = setConversationTitleIfFallback(conv.id, 'AI Generated Title');
		expect(ok).toBe(true);
		expect(getConversationTitleSource(conv.id)).toBe('ai');
	});

	it('setConversationTitleIfFallback is a no-op when source is already ai', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		// First AI write succeeds
		expect(setConversationTitleIfFallback(conv.id, 'First AI')).toBe(true);
		// Second write fails (already ai-sourced)
		expect(setConversationTitleIfFallback(conv.id, 'Second AI')).toBe(false);
		expect(getConversationTitleSource(conv.id)).toBe('ai');
	});

	it('setConversationTitleIfFallback is a no-op when source is user', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		renameConversation(conv.id, u.id, 'My Manual Title');
		expect(getConversationTitleSource(conv.id)).toBe('user');

		const ok = setConversationTitleIfFallback(conv.id, 'AI Override');
		expect(ok).toBe(false);
		expect(getConversationTitleSource(conv.id)).toBe('user');
	});
});

describe('renameConversation', () => {
	it('trims whitespace and persists with title_source = user', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		const ok = renameConversation(conv.id, u.id, '  New Title  ');
		expect(ok).toBe(true);
		expect(getConversationTitleSource(conv.id)).toBe('user');
	});

	it('rejects empty / whitespace-only titles', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		expect(() => renameConversation(conv.id, u.id, '')).toThrow(RenameValidationError);
		expect(() => renameConversation(conv.id, u.id, '   ')).toThrow(RenameValidationError);
	});

	it('rejects titles longer than 200 chars', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		const long = 'x'.repeat(201);
		expect(() => renameConversation(conv.id, u.id, long)).toThrow(RenameValidationError);
		// Exactly 200 should pass
		expect(renameConversation(conv.id, u.id, 'x'.repeat(200))).toBe(true);
	});

	it('returns false (404 semantics) for cross-user attempts', () => {
		const owner = seedUser();
		const attacker = seedUser();
		const conv = createConversation({
			userId: owner.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		const ok = renameConversation(conv.id, attacker.id, 'Hijacked');
		expect(ok).toBe(false);
		expect(getConversationTitleSource(conv.id)).toBe('fallback');
	});
});

describe('getConversationFirstExchange', () => {
	it('returns null when no messages exist', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		expect(getConversationFirstExchange(conv.id)).toBeNull();
	});

	it('returns user text without assistant when only user has sent', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'Hello world' }],
		});
		const ex = getConversationFirstExchange(conv.id);
		expect(ex).not.toBeNull();
		expect(ex!.userText).toBe('Hello world');
		expect(ex!.assistantText).toBeNull();
		expect(ex!.assistantHasMedia).toBe(false);
		expect(ex!.userMediaKinds).toEqual([]);
	});

	it('returns both user + assistant when first exchange complete', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'What is X?' }],
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'X is …' }],
		});
		const ex = getConversationFirstExchange(conv.id);
		expect(ex!.userText).toBe('What is X?');
		expect(ex!.assistantText).toBe('X is …');
	});

	it('reports user media kinds for image/video conversations', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::sdxl',
			modelKind: 'image',
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [
				{ type: 'text', text: 'a cat in a hat' },
				{ type: 'image', mediaId: 'm-1' },
			],
		});
		const ex = getConversationFirstExchange(conv.id);
		expect(ex!.userText).toBe('a cat in a hat');
		expect(ex!.userMediaKinds).toEqual(['image']);
	});

	it('detects assistant media for image responses (no text)', () => {
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::sdxl',
			modelKind: 'image',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'a sunset' }],
		});
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'image', mediaId: 'm-2' }],
		});
		const ex = getConversationFirstExchange(conv.id);
		expect(ex!.assistantText).toBe('');
		expect(ex!.assistantHasMedia).toBe(true);
	});

	it('ignores branches (only first-by-createdAt assistant child counts)', () => {
		// Title gen runs once before branching is possible, but the
		// query should still behave deterministically if called later.
		const u = seedUser();
		const conv = createConversation({
			userId: u.id,
			endpointId: 'bridge',
			modelId: 'bridge::gpt-4o',
			modelKind: 'chat',
		});
		const user = appendMessage({
			conversationId: conv.id,
			parentMessageId: null,
			role: 'user',
			parts: [{ type: 'text', text: 'q' }],
		});
		const first = appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'first answer' }],
		});
		// Sibling assistant from a regenerate
		appendMessage({
			conversationId: conv.id,
			parentMessageId: user.id,
			role: 'assistant',
			parts: [{ type: 'text', text: 'second answer' }],
		});
		setActiveLeafMessageId(conv.id, first.id);
		const ex = getConversationFirstExchange(conv.id);
		expect(ex!.assistantText).toBe('first answer');
	});
});
