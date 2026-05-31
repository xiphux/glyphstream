import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));

import {
	extractReasoning,
	importOwuiExport,
	stripOwuiFileUrls,
	IMPORTED_ENDPOINT_ID,
} from '$lib/server/import/owui';
import {
	getConversationDetail,
	listArchivedConversations,
	listConversations,
} from '$lib/server/db/queries/conversations';

beforeEach(() => {
	mocks.testDb = createTestDb();
});

afterEach(() => {
	closeTestDb();
});

/**
 * Synthetic OWUI export fixture in the same shape as the real export.
 * Tree-shaped history with two user/assistant pairs forming a linear
 * branch (parent → child → grandchild).
 */
function makeTextChat(overrides: { id?: string; archived?: boolean } = {}) {
	return {
		id: overrides.id ?? 'conv-1',
		user_id: 'owui-user-1',
		title: 'Sample chat',
		chat: {
			title: 'Sample chat',
			models: ['chatgpt'],
			history: {
				currentId: 'ai-2',
				messages: {
					'user-1': {
						id: 'user-1',
						parentId: null,
						childrenIds: ['ai-1'],
						role: 'user',
						content: 'Hello!',
						timestamp: 1700000000,
					},
					'ai-1': {
						id: 'ai-1',
						parentId: 'user-1',
						childrenIds: ['user-2'],
						role: 'assistant',
						content: 'Hi there!',
						timestamp: 1700000010,
						model: 'chatgpt',
					},
					'user-2': {
						id: 'user-2',
						parentId: 'ai-1',
						childrenIds: ['ai-2'],
						role: 'user',
						content: 'Tell me a joke',
						timestamp: 1700000020,
					},
					'ai-2': {
						id: 'ai-2',
						parentId: 'user-2',
						childrenIds: [],
						role: 'assistant',
						content: 'Why did the chicken…',
						timestamp: 1700000030,
						model: 'chatgpt',
					},
				},
			},
		},
		created_at: 1700000000,
		updated_at: 1700000040,
		archived: overrides.archived ?? false,
	};
}

function makeReasoningChat() {
	// Mirrors the real OWUI export shape: reasoning wrapped in a <details>
	// block with an HTML-encoded blockquoted body, followed by the actual
	// answer.
	return {
		id: 'reason-1',
		title: 'MoE vs dense',
		chat: {
			title: 'MoE vs dense',
			models: ['deepseek-v4-pro'],
			history: {
				currentId: 'ai-r',
				messages: {
					'user-r': {
						id: 'user-r',
						parentId: null,
						role: 'user',
						content: 'Why use dense over MoE?',
						timestamp: 1700002000,
					},
					'ai-r': {
						id: 'ai-r',
						parentId: 'user-r',
						role: 'assistant',
						content:
							'<details type="reasoning" done="true" duration="4">\n<summary>Thought for 4 seconds</summary>\n&gt; The user is asking about MoE vs dense.\n&gt;\n&gt; I&#x27;ll cover memory, training, &amp; inference.\n</details>\nDense models still thrive because of memory bandwidth limits and training simplicity.',
						timestamp: 1700002010,
						model: 'deepseek-v4-pro',
					},
				},
			},
		},
		created_at: 1700002000,
		updated_at: 1700002010,
		archived: false,
	};
}

function makeImageChat() {
	return {
		id: 'img-1',
		title: 'A red panda',
		chat: {
			title: 'A red panda',
			models: ['openai_image_video.comfyui/anima'],
			history: {
				currentId: 'ai-img',
				messages: {
					'user-img': {
						id: 'user-img',
						parentId: null,
						role: 'user',
						content: 'Draw a red panda',
						timestamp: 1700001000,
					},
					'ai-img': {
						id: 'ai-img',
						parentId: 'user-img',
						role: 'assistant',
						content: '![Generated Image](/api/v1/files/abc-123/content)',
						timestamp: 1700001010,
						model: 'openai_image_video.comfyui/anima',
					},
				},
			},
		},
		created_at: 1700001000,
		updated_at: 1700001010,
		archived: false,
	};
}

describe('importOwuiExport', () => {
	it('imports a text chat with branch walked in tree order', async () => {
		const u = seedUser();
		const result = await importOwuiExport([makeTextChat()], u.id, mocks.testDb);

		expect(result.imported).toBe(1);
		expect(result.archived).toBe(0);
		expect(result.skipped).toHaveLength(0);
		expect(result.errors).toHaveLength(0);

		const list = listConversations(u.id);
		expect(list).toHaveLength(1);
		const conv = list[0];
		expect(conv.title).toBe('Sample chat');
		// Timestamps preserved from the export (in ms).
		expect(conv.createdAt).toBe(1700000000 * 1000);
		expect(conv.updatedAt).toBe(1700000040 * 1000);

		const detail = getConversationDetail(conv.id, u.id);
		expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		expect(detail?.messages.map((m) => m.parts[0])).toEqual([
			{ type: 'text', text: 'Hello!' },
			{ type: 'text', text: 'Hi there!' },
			{ type: 'text', text: 'Tell me a joke' },
			{ type: 'text', text: 'Why did the chicken…' },
		]);
		// activeLeaf points to the last assistant message.
		expect(detail?.activeLeafMessageId).toBe(detail?.messages[3].id);
	});

	it('uses the synthetic imported endpoint id', async () => {
		const u = seedUser();
		await importOwuiExport([makeTextChat()], u.id, mocks.testDb);
		const detail = getConversationDetail(listConversations(u.id)[0].id, u.id);
		expect(detail?.endpointId).toBe(IMPORTED_ENDPOINT_ID);
		expect(detail?.modelId).toBe('chatgpt');
		expect(detail?.modelKind).toBe('chat');
	});

	it('detects image kind from model name substring', async () => {
		const u = seedUser();
		await importOwuiExport([makeImageChat()], u.id, mocks.testDb);
		const detail = getConversationDetail(listConversations(u.id)[0].id, u.id);
		expect(detail?.modelKind).toBe('image');
	});

	it('rewrites OWUI file-URL image markdown to a placeholder', async () => {
		const u = seedUser();
		await importOwuiExport([makeImageChat()], u.id, mocks.testDb);
		const detail = getConversationDetail(listConversations(u.id)[0].id, u.id);
		const assistant = detail?.messages.find((m) => m.role === 'assistant');
		expect(assistant?.parts[0]).toEqual({
			type: 'text',
			text: '_[image unavailable: Generated Image]_',
		});
	});

	it('renders assistant markdown to contentHtml so the UI shows formatted output', async () => {
		const u = seedUser();
		await importOwuiExport([makeTextChat()], u.id, mocks.testDb);
		const detail = getConversationDetail(listConversations(u.id)[0].id, u.id);
		const userMsg = detail?.messages.find((m) => m.role === 'user');
		const assistantMsg = detail?.messages.find((m) => m.role === 'assistant');
		// User messages stay as plain text (consistent with normal chats).
		expect(userMsg?.contentHtml).toBeNull();
		// Assistant messages get HTML so the chat shows formatted markdown.
		expect(assistantMsg?.contentHtml).toContain('<p>');
	});

	it('OWUI archived flag → archivedAt = updatedAt', async () => {
		const u = seedUser();
		await importOwuiExport([makeTextChat({ id: 'arch-1', archived: true })], u.id, mocks.testDb);
		expect(listConversations(u.id)).toHaveLength(0);
		const archived = listArchivedConversations(u.id);
		expect(archived).toHaveLength(1);
		expect(archived[0].title).toBe('Sample chat');
	});

	it('imports many conversations from one export', async () => {
		const u = seedUser();
		const exports = [
			makeTextChat({ id: 'a' }),
			makeTextChat({ id: 'b' }),
			makeTextChat({ id: 'c', archived: true }),
		];
		const result = await importOwuiExport(exports, u.id, mocks.testDb);
		expect(result.imported).toBe(3);
		expect(result.archived).toBe(1);
		expect(listConversations(u.id)).toHaveLength(2);
		expect(listArchivedConversations(u.id)).toHaveLength(1);
	});

	it('skips entries without chat.history.messages', async () => {
		const u = seedUser();
		const result = await importOwuiExport(
			[{ id: 'broken', chat: {} }, makeTextChat()],
			u.id,
			mocks.testDb,
		);
		expect(result.imported).toBe(1);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].id).toBe('broken');
	});

	it('throws when the root is not an array', async () => {
		const u = seedUser();
		await expect(importOwuiExport({ not: 'an array' }, u.id, mocks.testDb)).rejects.toThrow(
			/must be an array/i,
		);
	});

	it('dryRun does not write to the DB', async () => {
		const u = seedUser();
		const result = await importOwuiExport([makeTextChat()], u.id, mocks.testDb, {
			dryRun: true,
		});
		expect(result.imported).toBe(1);
		expect(listConversations(u.id)).toHaveLength(0);
	});

	it('imports without crashing when activeLeaf is missing', async () => {
		const u = seedUser();
		const entry = makeTextChat();
		delete (entry.chat.history as { currentId?: string }).currentId;
		const result = await importOwuiExport([entry], u.id, mocks.testDb);
		expect(result.imported).toBe(1);
		// Should still set activeLeaf to the last inserted message so the
		// chat isn't a "headless" conversation that breaks getConversationDetail.
		const detail = getConversationDetail(listConversations(u.id)[0].id, u.id);
		expect(detail?.activeLeafMessageId).not.toBeNull();
	});

	it('preserves modelUsed on assistant messages', async () => {
		const u = seedUser();
		await importOwuiExport([makeTextChat()], u.id, mocks.testDb);
		const detail = getConversationDetail(listConversations(u.id)[0].id, u.id);
		const assistantA = detail?.messages.find((m) => m.role === 'assistant');
		expect(assistantA?.modelUsed).toBe('chatgpt');
	});
});

/**
 * Opt-in integration tests against the user's real OWUI export fixtures.
 * Skipped automatically in CI (where these files don't exist); runs
 * locally to validate the parser handles the actual export shape, not
 * just our synthetic fixtures. Files are intentionally not committed —
 * they contain personal chat history.
 */
const REAL_EXPORTS = ['text-chat.json', 'image-chat.json', 'chat-export.json'];
const haveRealExports = REAL_EXPORTS.every((f) => existsSync(f));

describe.skipIf(!haveRealExports)('against real OWUI export fixtures', () => {
	it('imports text-chat.json without errors', async () => {
		const u = seedUser();
		const json = JSON.parse(readFileSync('text-chat.json', 'utf8'));
		const result = await importOwuiExport(json, u.id, mocks.testDb);
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);
	});

	it('imports image-chat.json — image kind detected, file URLs stripped', async () => {
		const u = seedUser();
		const json = JSON.parse(readFileSync('image-chat.json', 'utf8'));
		const result = await importOwuiExport(json, u.id, mocks.testDb);
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);
		const conv = listConversations(u.id)[0];
		const detail = getConversationDetail(conv.id, u.id);
		expect(detail?.modelKind).toBe('image');
		const assistant = detail?.messages.find((m) => m.role === 'assistant');
		const text = (assistant?.parts[0] as { type: 'text'; text: string }).text;
		expect(text).toContain('image unavailable');
		expect(text).not.toContain('/api/v1/files/');
	});

	it('imports chat-export.json full export with no errors', async () => {
		const u = seedUser();
		const json = JSON.parse(readFileSync('chat-export.json', 'utf8'));
		const result = await importOwuiExport(json, u.id, mocks.testDb);
		expect(result.errors).toEqual([]);
		// Just sanity: should import some non-trivial number.
		expect(result.imported).toBeGreaterThan(0);
		console.log(
			`[real-export] imported=${result.imported}, archived=${result.archived}, skipped=${result.skipped.length}`,
		);
	});
});

describe('extractReasoning', () => {
	it('returns null reasoning when no <details> block is present', () => {
		expect(extractReasoning('Just an answer.')).toEqual({
			reasoning: null,
			content: 'Just an answer.',
		});
	});

	it('extracts reasoning, decodes entities, strips blockquote prefix', () => {
		const raw =
			'<details type="reasoning" done="true" duration="4">\n<summary>Thought for 4s</summary>\n&gt; First line.\n&gt; Second line with &quot;quotes&quot;.\n</details>\nThe answer.';
		const r = extractReasoning(raw);
		expect(r.reasoning).toBe('First line.\nSecond line with "quotes".');
		expect(r.content).toBe('The answer.');
	});

	it('drops the <summary> element so it does not leak into reasoning', () => {
		const raw =
			'<details type="reasoning" done="true">\n<summary>Thought for 7s</summary>\n&gt; The reason\n</details>\nFinal.';
		const r = extractReasoning(raw);
		expect(r.reasoning).toBe('The reason');
		expect(r.reasoning).not.toContain('Thought for 7s');
	});

	it('decodes numeric and hex character references', () => {
		const raw =
			'<details type="reasoning"><summary>x</summary>\n&gt; quoted &#39; and &#x27;\n</details>\nA.';
		expect(extractReasoning(raw).reasoning).toBe("quoted ' and '");
	});

	it('returns empty reasoning as null (no spurious empty parts)', () => {
		const raw = '<details type="reasoning"><summary>x</summary></details>\nAnswer.';
		expect(extractReasoning(raw)).toEqual({
			reasoning: null,
			content: 'Answer.',
		});
	});

	it('preserves answer formatting after the details block', () => {
		const raw =
			'<details type="reasoning"><summary>x</summary>\n&gt; r\n</details>\n# Heading\n\nBody.';
		const r = extractReasoning(raw);
		expect(r.content).toBe('# Heading\n\nBody.');
	});
});

describe('importOwuiExport with reasoning', () => {
	it('splits reasoning into a separate part + populates reasoningText', async () => {
		const u = seedUser();
		await importOwuiExport([makeReasoningChat()], u.id, mocks.testDb);
		const detail = getConversationDetail(listConversations(u.id)[0].id, u.id);
		const assistant = detail?.messages.find((m) => m.role === 'assistant');
		expect(assistant?.parts).toEqual([
			{
				type: 'reasoning',
				text: "The user is asking about MoE vs dense.\n\nI'll cover memory, training, & inference.",
			},
			{
				type: 'text',
				text: 'Dense models still thrive because of memory bandwidth limits and training simplicity.',
			},
		]);
		expect(assistant?.reasoningText).toBe(
			"The user is asking about MoE vs dense.\n\nI'll cover memory, training, & inference.",
		);
	});

	it('contentHtml renders only the answer, not the reasoning', async () => {
		const u = seedUser();
		await importOwuiExport([makeReasoningChat()], u.id, mocks.testDb);
		const detail = getConversationDetail(listConversations(u.id)[0].id, u.id);
		const assistant = detail?.messages.find((m) => m.role === 'assistant');
		// Should contain the answer text, not the reasoning preamble.
		expect(assistant?.contentHtml).toContain('Dense models');
		expect(assistant?.contentHtml).not.toContain('MoE vs dense');
		// And no leftover <details> tag.
		expect(assistant?.contentHtml).not.toContain('<details');
	});
});

describe('stripOwuiFileUrls', () => {
	it('replaces single-line image references', () => {
		expect(stripOwuiFileUrls('![Generated Image](/api/v1/files/abc-123/content)')).toBe(
			'_[image unavailable: Generated Image]_',
		);
	});

	it('replaces multiple references in one message', () => {
		const input = 'First: ![A](/api/v1/files/x/content) and second: ![B](/api/v1/files/y/content)';
		expect(stripOwuiFileUrls(input)).toBe(
			'First: _[image unavailable: A]_ and second: _[image unavailable: B]_',
		);
	});

	it('handles empty alt text', () => {
		expect(stripOwuiFileUrls('![](/api/v1/files/x/content)')).toBe('_[image unavailable]_');
	});

	it('leaves non-OWUI image references alone', () => {
		const md = '![External](https://example.com/foo.png)';
		expect(stripOwuiFileUrls(md)).toBe(md);
	});

	it('preserves surrounding markdown', () => {
		expect(
			stripOwuiFileUrls("Here is a picture:\n\n![A](/api/v1/files/abc/content)\n\nIsn't it nice?"),
		).toBe("Here is a picture:\n\n_[image unavailable: A]_\n\nIsn't it nice?");
	});
});
