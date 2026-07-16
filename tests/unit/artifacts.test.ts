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
import { computeEdit } from '$lib/server/tools/update-canvas';
import { deriveCanvasTitle } from '$lib/server/tools/create-canvas';

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

		const active = getActiveCanvas(convId, user.id);
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

		const active = getActiveCanvas(convId, user.id);
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
		expect(getActiveCanvas(convId, user.id)!.content).toBe('v2');
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
		expect(getActiveCanvas(convId, user.id)!.title).toBe('New Name');
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
		expect(getActiveCanvas(convId, user.id)!.title).toBe('Keep Me');
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
		expect(getActiveCanvas(convId, owner.id)).not.toBeNull();
		expect(getActiveCanvas(convId, other.id)).toBeNull();
	});

	it('returns the most-recently-updated non-deleted canvas', () => {
		const user = seedUser();
		const convId = seedConv(user.id);
		createCanvas({
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
		// Both exist; getActiveCanvas returns the newest by updated_at.
		expect(getActiveCanvas(convId, user.id)!.id).toBe(second.id);
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
