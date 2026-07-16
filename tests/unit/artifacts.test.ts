import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.testDb, closeDb: () => {} }));

import { createConversation } from '$lib/server/db/queries/conversations';
import {
	appendCanvasVersion,
	createCanvas,
	getCanvasById,
	listActiveCanvases,
} from '$lib/server/db/queries/artifacts';
import { computeEdit, updateCanvasTool } from '$lib/server/tools/update-canvas';
import { deriveCanvasTitle } from '$lib/server/tools/create-canvas';
import type { ToolContext } from '$lib/server/tools/types';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());

function seedConv(userId: string): string {
	return createConversation({
		userId,
		endpointId: 'bridge',
		modelId: 'bridge::x',
		modelKind: 'chat',
		title: 'T',
	}).id;
}

/** The single active canvas for a conversation (test convenience). */
function activeCanvas(convId: string, userId: string) {
	return listActiveCanvases(convId, userId)[0] ?? null;
}

describe('artifacts queries', () => {
	it('creates a canvas with a first version and a current pointer', () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		const doc = createCanvas({
			userId: user.id,
			conversationId: convId,
			title: 'Doc',
			content: '# Hello',
			contentHtml: '<h1>Hello</h1>',
			createdByMessageId: null,
		});
		expect(doc.versionNumber).toBe(1);
		expect(doc.currentVersionId).toBeTruthy();

		const active = activeCanvas(convId, user.id);
		expect(active).not.toBeNull();
		expect(active!.id).toBe(doc.id);
		expect(active!.content).toBe('# Hello');
		expect(active!.title).toBe('Doc');
		expect(active!.versionNumber).toBe(1);
	});

	it('appends a version and advances the pointer (CAS on the current version)', () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		const doc = createCanvas({
			userId: user.id,
			conversationId: convId,
			title: null,
			content: 'v1',
			contentHtml: null,
			createdByMessageId: null,
		});

		const res = appendCanvasVersion({
			artifactId: doc.id,
			userId: user.id,
			expectedCurrentVersionId: doc.currentVersionId,
			content: 'v2',
			contentHtml: null,
			createdByMessageId: null,
			editSource: 'agent',
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.doc.versionNumber).toBe(2);
		expect(res.doc.content).toBe('v2');

		const active = activeCanvas(convId, user.id);
		expect(active!.versionNumber).toBe(2);
		expect(active!.content).toBe('v2');
		expect(active!.currentVersionId).toBe(res.doc.currentVersionId);
	});

	it('rejects an append whose expected version no longer matches (conflict)', () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		const doc = createCanvas({
			userId: user.id,
			conversationId: convId,
			title: null,
			content: 'v1',
			contentHtml: null,
			createdByMessageId: null,
		});
		const staleVersionId = doc.currentVersionId;

		// A first edit moves the pointer.
		appendCanvasVersion({
			artifactId: doc.id,
			userId: user.id,
			expectedCurrentVersionId: staleVersionId,
			content: 'v2',
			contentHtml: null,
			createdByMessageId: null,
			editSource: 'agent',
		});

		// A second edit built against the now-stale version is rejected.
		const conflict = appendCanvasVersion({
			artifactId: doc.id,
			userId: user.id,
			expectedCurrentVersionId: staleVersionId,
			content: 'v2-alt',
			contentHtml: null,
			createdByMessageId: null,
			editSource: 'agent',
		});
		expect(conflict).toEqual({ ok: false, reason: 'conflict' });
		expect(activeCanvas(convId, user.id)!.content).toBe('v2');
	});

	it('renames the artifact when a title is passed to appendCanvasVersion', () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		const doc = createCanvas({
			userId: user.id,
			conversationId: convId,
			title: 'Old Name',
			content: 'body',
			contentHtml: null,
			createdByMessageId: null,
		});
		const res = appendCanvasVersion({
			artifactId: doc.id,
			userId: user.id,
			expectedCurrentVersionId: doc.currentVersionId,
			content: 'body edited',
			contentHtml: null,
			createdByMessageId: null,
			editSource: 'agent',
			title: 'New Name',
		});
		expect(res.ok && res.doc.title).toBe('New Name');
		expect(activeCanvas(convId, user.id)!.title).toBe('New Name');
	});

	it('leaves the title unchanged when no title is passed', () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		const doc = createCanvas({
			userId: user.id,
			conversationId: convId,
			title: 'Keep Me',
			content: 'body',
			contentHtml: null,
			createdByMessageId: null,
		});
		appendCanvasVersion({
			artifactId: doc.id,
			userId: user.id,
			expectedCurrentVersionId: doc.currentVersionId,
			content: 'edited',
			contentHtml: null,
			createdByMessageId: null,
			editSource: 'agent',
		});
		expect(activeCanvas(convId, user.id)!.title).toBe('Keep Me');
	});

	it('scopes canvases to their owner', () => {
		const owner = seedUser();
		const other = seedUser();
		const convId = seedConv(owner.id);
		createCanvas({
			userId: owner.id,
			conversationId: convId,
			title: null,
			content: 'secret',
			contentHtml: null,
			createdByMessageId: null,
		});
		expect(activeCanvas(convId, owner.id)).not.toBeNull();
		expect(activeCanvas(convId, other.id)).toBeNull();
	});

	it('lists multiple canvases in stable creation order, and resolves one by id', () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		const first = createCanvas({
			userId: user.id,
			conversationId: convId,
			title: 'first',
			content: 'a',
			contentHtml: null,
			createdByMessageId: null,
		});
		const second = createCanvas({
			userId: user.id,
			conversationId: convId,
			title: 'second',
			content: 'b',
			contentHtml: null,
			createdByMessageId: null,
		});

		const order = listActiveCanvases(convId, user.id).map((c) => c.id);
		expect(order).toHaveLength(2);
		expect(order).toContain(first.id);
		expect(order).toContain(second.id);

		// Editing one must NOT reorder the list — the order is deterministic
		// (createdAt, then id), so it stays byte-stable for the prefix cache.
		appendCanvasVersion({
			artifactId: first.id,
			userId: user.id,
			expectedCurrentVersionId: first.currentVersionId,
			content: 'a2',
			contentHtml: null,
			createdByMessageId: null,
			editSource: 'agent',
		});
		expect(listActiveCanvases(convId, user.id).map((c) => c.id)).toEqual(order);

		expect(getCanvasById(second.id, convId, user.id)?.title).toBe('second');
	});

	it('getCanvasById is scoped to conversation + owner', () => {
		const owner = seedUser();
		const other = seedUser();
		const convId = seedConv(owner.id);
		const doc = createCanvas({
			userId: owner.id,
			conversationId: convId,
			title: 'mine',
			content: 'x',
			contentHtml: null,
			createdByMessageId: null,
		});
		expect(getCanvasById(doc.id, convId, owner.id)).not.toBeNull();
		expect(getCanvasById(doc.id, convId, other.id)).toBeNull();
		expect(getCanvasById(doc.id, 'some-other-conversation', owner.id)).toBeNull();
	});
});

describe('update_canvas targeting (multiple canvases)', () => {
	function ctx(conversationId: string, userId: string): ToolContext {
		return {
			userId,
			conversationId,
			signal: new AbortController().signal,
			disabledFeatures: [],
		};
	}
	function seedCanvas(convId: string, userId: string, title: string, content: string) {
		return createCanvas({
			userId,
			conversationId: convId,
			title,
			content,
			contentHtml: null,
			createdByMessageId: null,
		});
	}

	it('edits the sole canvas without an artifact_id', async () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		seedCanvas(convId, user.id, 'Only', 'hello world');
		const res = await updateCanvasTool.execute(
			{ command: 'str_replace', old_str: 'world', new_str: 'there' },
			ctx(convId, user.id),
		);
		expect(res.isError).toBeFalsy();
		expect(activeCanvas(convId, user.id)!.content).toBe('hello there');
	});

	it('requires an artifact_id when more than one canvas is open', async () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		seedCanvas(convId, user.id, 'A', 'aaa');
		seedCanvas(convId, user.id, 'B', 'bbb');
		const res = await updateCanvasTool.execute(
			{ command: 'rewrite', content: 'nope' },
			ctx(convId, user.id),
		);
		expect(res.isError).toBe(true);
		expect(res.content).toMatch(/more than one/i);
	});

	it('edits the named canvas when artifact_id is given', async () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		const a = seedCanvas(convId, user.id, 'A', 'aaa');
		const b = seedCanvas(convId, user.id, 'B', 'bbb');
		const res = await updateCanvasTool.execute(
			{ command: 'rewrite', content: 'B edited', artifact_id: b.id },
			ctx(convId, user.id),
		);
		expect(res.isError).toBeFalsy();
		expect(listActiveCanvases(convId, user.id).find((c) => c.id === b.id)!.content).toBe(
			'B edited',
		);
		// A is untouched.
		expect(listActiveCanvases(convId, user.id).find((c) => c.id === a.id)!.content).toBe('aaa');
	});

	it('errors on an unknown artifact_id', async () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		seedCanvas(convId, user.id, 'A', 'aaa');
		seedCanvas(convId, user.id, 'B', 'bbb');
		const res = await updateCanvasTool.execute(
			{ command: 'rewrite', content: 'x', artifact_id: 'nonexistent' },
			ctx(convId, user.id),
		);
		expect(res.isError).toBe(true);
		expect(res.content).toMatch(/no open canvas/i);
	});
});

describe('update_canvas edit computation', () => {
	it('rewrites the whole document', () => {
		expect(computeEdit({ command: 'rewrite', content: 'new' }, 'old')).toEqual({
			command: 'rewrite',
			content: 'new',
		});
	});

	it('str_replace replaces a unique occurrence', () => {
		const r = computeEdit(
			{ command: 'str_replace', old_str: 'brown', new_str: 'red' },
			'the brown fox',
		);
		expect(r).toEqual({ command: 'str_replace', content: 'the red fox' });
	});

	it('str_replace errors when old_str is not found', () => {
		const r = computeEdit(
			{ command: 'str_replace', old_str: 'zzz', new_str: 'x' },
			'the brown fox',
		);
		expect('error' in r).toBe(true);
	});

	it('str_replace errors when old_str matches more than once', () => {
		const r = computeEdit({ command: 'str_replace', old_str: 'a', new_str: 'x' }, 'a a a');
		expect('error' in r && r.error).toMatch(/3 times/);
	});

	it('rejects an unknown command and empty old_str', () => {
		expect('error' in computeEdit({ command: 'delete' }, 'x')).toBe(true);
		expect('error' in computeEdit({ command: 'str_replace', old_str: '', new_str: 'y' }, 'x')).toBe(
			true,
		);
	});
});

describe('deriveCanvasTitle', () => {
	it('uses the first markdown heading', () => {
		expect(deriveCanvasTitle('# Morning Walks\n\nbody')).toBe('Morning Walks');
		expect(deriveCanvasTitle('\n\n## A Sub Heading\ntext')).toBe('A Sub Heading');
	});

	it('falls back to the first non-empty line, stripped of markers', () => {
		expect(deriveCanvasTitle('**Bold intro** line\nmore')).toBe('Bold intro line');
	});

	it('truncates a very long first line', () => {
		const long = 'x'.repeat(100);
		const out = deriveCanvasTitle(long);
		expect(out.length).toBeLessThanOrEqual(60);
		expect(out.endsWith('…')).toBe(true);
	});

	it('returns a placeholder for empty content', () => {
		expect(deriveCanvasTitle('   \n\n')).toBe('Untitled canvas');
	});
});
