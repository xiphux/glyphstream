import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

import { createConversation } from '$lib/server/db/queries/conversations';
import {
	appendCanvasVersion,
	createCanvas,
	getActiveCanvas,
} from '$lib/server/db/queries/artifacts';
import { augmentRequestForCanvas } from '$lib/server/chat/tool-context';
import type { ChatCompletionRequest } from '$lib/server/endpoints/client';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

function baseReq(): ChatCompletionRequest {
	return {
		model: 'bridge::x',
		messages: [
			{ role: 'system', content: 'You are helpful.' },
			{ role: 'user', content: 'draft me a doc' },
		],
		tools: [
			{ type: 'function', function: { name: 'create_canvas', description: 'x', parameters: {} } },
		],
	};
}

function seedCanvasConv(content: string) {
	const user = seedUser();
	const convId = createConversation({
		userId: user.id,
		endpointId: 'bridge',
		modelId: 'bridge::x',
		modelKind: 'chat',
		title: 'T',
	}).id;
	createCanvas({
		userId: user.id,
		conversationId: convId,
		title: 'Doc',
		content,
		contentHtml: null,
		createdByMessageId: null,
	});
	return { userId: user.id, convId };
}

describe('augmentRequestForCanvas', () => {
	it('arms update_canvas and appends the doc as a single system tail block', () => {
		const { userId, convId } = seedCanvasConv('# Title\n\nbody text');
		const out = augmentRequestForCanvas(baseReq(), {
			conversationId: convId,
			userId,
			disabledFeatures: [],
			supportsTools: true,
		});

		expect(out.tools?.some((t) => t.function.name === 'update_canvas')).toBe(true);
		const tail = out.messages[out.messages.length - 1];
		expect(tail.role).toBe('system');
		expect(tail.content).toContain('<canvas_current_state version="1"');
		expect(tail.content).toContain('body text');
		// The doc text appears ONLY in the tail, never earlier (prefix stays clean).
		const earlier = out.messages
			.slice(0, -1)
			.map((m) => m.content)
			.join('\n');
		expect(earlier).not.toContain('body text');
	});

	it('is a no-op when tools are unsupported, canvas is disabled, or no canvas exists', () => {
		const { userId, convId } = seedCanvasConv('body');

		const noTools = augmentRequestForCanvas(baseReq(), {
			conversationId: convId,
			userId,
			disabledFeatures: [],
			supportsTools: false,
		});
		expect(noTools.messages).toHaveLength(2);

		const disabled = augmentRequestForCanvas(baseReq(), {
			conversationId: convId,
			userId,
			disabledFeatures: ['canvas'],
			supportsTools: true,
		});
		expect(disabled.messages).toHaveLength(2);

		const other = seedUser();
		const noCanvas = augmentRequestForCanvas(baseReq(), {
			conversationId: convId,
			userId: other.id, // scoped out — sees no canvas
			disabledFeatures: [],
			supportsTools: true,
		});
		expect(noCanvas.messages).toHaveLength(2);
		expect(noCanvas.tools?.some((t) => t.function.name === 'update_canvas')).toBeFalsy();
	});

	it('keeps the prefix (system + tools) byte-identical across edits — only the tail changes', () => {
		const { userId, convId } = seedCanvasConv('version one body');
		const first = augmentRequestForCanvas(baseReq(), {
			conversationId: convId,
			userId,
			disabledFeatures: [],
			supportsTools: true,
		});

		// A later edit changes the document.
		const head = getActiveCanvas(convId, userId)!;
		appendCanvasVersion({
			artifactId: head.id,
			userId,
			expectedCurrentVersionId: head.currentVersionId,
			content: 'version two body',
			contentHtml: null,
			createdByMessageId: null,
			editSource: 'agent',
		});

		const second = augmentRequestForCanvas(baseReq(), {
			conversationId: convId,
			userId,
			disabledFeatures: [],
			supportsTools: true,
		});

		// Everything except the final tail block is identical.
		expect(JSON.stringify(second.messages.slice(0, -1))).toBe(
			JSON.stringify(first.messages.slice(0, -1)),
		);
		expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
		// The tail reflects the new version + content.
		const tail = second.messages[second.messages.length - 1];
		expect(tail.content).toContain('version="2"');
		expect(tail.content).toContain('version two body');
	});
});
