/**
 * The durable error row a failed generation leaves. Its part's shape is what a
 * reload reads back, so a chat failure must keep carrying no `sourceMediaId`
 * while a media failure records one (null for text-to-media).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { createConversation } from '#lib/server/db/queries/conversations.js';
import { appendMessage, getMessage } from '#lib/server/db/queries/messages.js';
import { appendErrorSibling } from '#lib/server/streaming/error-sibling.js';

let conversationId: string;
let userMessageId: string;

beforeEach(() => {
	createTestDb();
	const user = seedUser();
	conversationId = createConversation({
		userId: user.id,
		endpointId: 'bridge',
		modelId: 'bridge::m',
		modelKind: 'chat',
	}).id;
	userMessageId = appendMessage({
		conversationId,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: 'hello' }],
	}).id;
});
afterEach(() => closeTestDb());

describe('appendErrorSibling', () => {
	it('writes an assistant row whose only part is the error, with no sourceMediaId when none is given', () => {
		const id = appendErrorSibling({
			conversationId,
			parentMessageId: userMessageId,
			message: 'Upstream exploded',
			modelUsed: 'bridge::m',
			advanceActiveLeaf: true,
		});
		const row = getMessage(conversationId, id)!;
		expect(row.role).toBe('assistant');
		expect(row.parentMessageId).toBe(userMessageId);
		expect(row.parts).toEqual([{ type: 'error', message: 'Upstream exploded' }]);
		expect('sourceMediaId' in row.parts[0]).toBe(false);
	});

	it('records sourceMediaId when given, including null', () => {
		const id = appendErrorSibling({
			conversationId,
			parentMessageId: userMessageId,
			message: 'No GPU',
			sourceMediaId: null,
			advanceActiveLeaf: false,
		});
		expect(getMessage(conversationId, id)!.parts).toEqual([
			{ type: 'error', message: 'No GPU', sourceMediaId: null },
		]);
	});
});
