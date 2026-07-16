import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { generateId } from '../../util/id';
import { getDb } from '../client';
import { artifacts, artifactVersions } from '../schema';

/**
 * Canvas persistence. An `artifact` is the mutable document; its content lives
 * in an append-only `artifact_versions` chain, with `artifacts.current_version_id`
 * pointing at the head. Every function is user-scoped (ANDs `user_id`) per the
 * multi-user isolation invariant.
 *
 * Phase 1 treats a conversation as having at most ONE active canvas — the
 * most-recently-updated non-deleted artifact. The schema allows several (no
 * uniqueness constraint), so a multi-canvas switcher can land later with no
 * migration; `create_canvas` just declines to make a second one for now.
 */

/** An artifact plus the content of its current version — the shape the tool
 *  acks, the tail-injection block, and the pane all read. */
export interface CanvasDoc {
	id: string;
	conversationId: string;
	title: string | null;
	kind: 'markdown';
	/** Current markdown content (empty string when no version yet — shouldn't
	 *  happen once created, since creation writes a first version). */
	content: string;
	contentHtml: string | null;
	/** Head-of-chain version id; the compare-and-swap token for edits. */
	currentVersionId: string | null;
	/** 1-based count of versions in the chain (what acks/`<canvas_current_state
	 *  version="N">` report). */
	versionNumber: number;
	updatedAt: number;
}

function countVersions(artifactId: string): number {
	const db = getDb();
	const row = db
		.select({ n: sql<number>`count(*)` })
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.get();
	return row?.n ?? 0;
}

const CANVAS_COLUMNS = {
	id: artifacts.id,
	conversationId: artifacts.conversationId,
	title: artifacts.title,
	kind: artifacts.kind,
	currentVersionId: artifacts.currentVersionId,
	updatedAt: artifacts.updatedAt,
	content: artifactVersions.content,
	contentHtml: artifactVersions.contentHtml,
} as const;

type CanvasRow = {
	id: string;
	conversationId: string;
	title: string | null;
	kind: 'markdown';
	currentVersionId: string | null;
	updatedAt: number;
	content: string | null;
	contentHtml: string | null;
};

function toCanvasDoc(row: CanvasRow): CanvasDoc {
	return {
		id: row.id,
		conversationId: row.conversationId,
		title: row.title,
		kind: row.kind,
		content: row.content ?? '',
		contentHtml: row.contentHtml,
		currentVersionId: row.currentVersionId,
		versionNumber: countVersions(row.id),
		updatedAt: row.updatedAt,
	};
}

/**
 * All of the conversation's active (non-deleted) canvases with their current
 * content, in a STABLE order (creation time, then id as tiebreak). Order must
 * not depend on which was last edited: the send path injects one tail block per
 * canvas, and reordering them when nothing structural changed would bust the
 * upstream's prefix cache (the "payload is rent" invariant). Used to build the
 * tail blocks + arm `update_canvas`, and to rehydrate the pane on page load.
 */
export function listActiveCanvases(conversationId: string, userId: string): CanvasDoc[] {
	const db = getDb();
	const rows = db
		.select(CANVAS_COLUMNS)
		.from(artifacts)
		.leftJoin(artifactVersions, eq(artifacts.currentVersionId, artifactVersions.id))
		.where(
			and(
				eq(artifacts.conversationId, conversationId),
				eq(artifacts.userId, userId),
				isNull(artifacts.deletedAt),
			),
		)
		.orderBy(asc(artifacts.createdAt), asc(artifacts.id))
		.all();
	return rows.map(toCanvasDoc);
}

/**
 * A specific canvas by id, scoped to its conversation + owner (so a stray id
 * can't reach another user's or conversation's artifact). Used by `update_canvas`
 * to resolve the edit target when the model names one.
 */
export function getCanvasById(
	artifactId: string,
	conversationId: string,
	userId: string,
): CanvasDoc | null {
	const db = getDb();
	const row = db
		.select(CANVAS_COLUMNS)
		.from(artifacts)
		.leftJoin(artifactVersions, eq(artifacts.currentVersionId, artifactVersions.id))
		.where(
			and(
				eq(artifacts.id, artifactId),
				eq(artifacts.conversationId, conversationId),
				eq(artifacts.userId, userId),
				isNull(artifacts.deletedAt),
			),
		)
		.get();
	return row ? toCanvasDoc(row) : null;
}

export interface CreateCanvasInput {
	userId: string;
	conversationId: string;
	title: string | null;
	content: string;
	contentHtml: string | null;
	createdByMessageId: string | null;
}

/**
 * Create a new artifact and its first version, atomically. Order: insert the
 * artifact (current_version_id null), insert the version (FKs the artifact),
 * then point the artifact at it — the nullable-cyclic dance
 * `conversations.active_leaf_message_id` uses. Runs in one synchronous
 * transaction (no awaits inside), so it's atomic even if two tool calls race.
 */
export function createCanvas(input: CreateCanvasInput): CanvasDoc {
	const db = getDb();
	const artifactId = generateId();
	const versionId = generateId();
	const now = Date.now();

	db.transaction((tx) => {
		tx.insert(artifacts)
			.values({
				id: artifactId,
				userId: input.userId,
				conversationId: input.conversationId,
				title: input.title,
				kind: 'markdown',
				currentVersionId: null,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		tx.insert(artifactVersions)
			.values({
				id: versionId,
				artifactId,
				parentVersionId: null,
				content: input.content,
				contentHtml: input.contentHtml,
				createdByMessageId: input.createdByMessageId,
				editSource: 'agent',
				createdAt: now,
			})
			.run();
		tx.update(artifacts)
			.set({ currentVersionId: versionId, updatedAt: now })
			.where(eq(artifacts.id, artifactId))
			.run();
	});

	return {
		id: artifactId,
		conversationId: input.conversationId,
		title: input.title,
		kind: 'markdown',
		content: input.content,
		contentHtml: input.contentHtml,
		currentVersionId: versionId,
		versionNumber: 1,
		updatedAt: now,
	};
}

export interface AppendCanvasVersionInput {
	artifactId: string;
	userId: string;
	/** The version id the edit was computed against. The write only lands if the
	 *  artifact still points here — otherwise a concurrent edit moved the head
	 *  and we report a conflict so the caller re-reads and retries. */
	expectedCurrentVersionId: string | null;
	content: string;
	contentHtml: string | null;
	createdByMessageId: string | null;
	editSource: 'agent' | 'user';
	/** New artifact title (a rename). Undefined leaves the current title as-is. */
	title?: string;
}

export type AppendCanvasVersionResult =
	{ ok: true; doc: CanvasDoc } | { ok: false; reason: 'not_found' | 'conflict' };

/**
 * Append a version to an existing artifact and advance the head pointer,
 * atomically, with an optimistic compare-and-swap on `expectedCurrentVersionId`.
 * Markdown must already be rendered by the caller (renderMarkdown is async and
 * can't run inside node:sqlite's synchronous transaction). Ownership is enforced
 * by the `user_id` guard in the pre-check.
 */
export function appendCanvasVersion(input: AppendCanvasVersionInput): AppendCanvasVersionResult {
	const db = getDb();
	const versionId = generateId();
	const now = Date.now();

	let outcome: AppendCanvasVersionResult = { ok: false, reason: 'not_found' };
	db.transaction((tx) => {
		const current = tx
			.select({ currentVersionId: artifacts.currentVersionId })
			.from(artifacts)
			.where(
				and(
					eq(artifacts.id, input.artifactId),
					eq(artifacts.userId, input.userId),
					isNull(artifacts.deletedAt),
				),
			)
			.get();
		if (!current) {
			outcome = { ok: false, reason: 'not_found' };
			return;
		}
		if (current.currentVersionId !== input.expectedCurrentVersionId) {
			outcome = { ok: false, reason: 'conflict' };
			return;
		}
		tx.insert(artifactVersions)
			.values({
				id: versionId,
				artifactId: input.artifactId,
				parentVersionId: current.currentVersionId,
				content: input.content,
				contentHtml: input.contentHtml,
				createdByMessageId: input.createdByMessageId,
				editSource: input.editSource,
				createdAt: now,
			})
			.run();
		tx.update(artifacts)
			.set({
				currentVersionId: versionId,
				updatedAt: now,
				...(input.title !== undefined ? { title: input.title } : {}),
			})
			.where(eq(artifacts.id, input.artifactId))
			.run();
		outcome = { ok: true, doc: null as unknown as CanvasDoc };
	});

	if (!outcome.ok) return outcome;
	return {
		ok: true,
		doc: {
			id: input.artifactId,
			// conversationId/title are stable across edits; the caller already
			// holds them, but re-read keeps this function self-contained.
			...readCanvasHeader(input.artifactId),
			content: input.content,
			contentHtml: input.contentHtml,
			currentVersionId: versionId,
			versionNumber: countVersions(input.artifactId),
			updatedAt: now,
		},
	};
}

/** Small header read (conversationId, title, kind) so appendCanvasVersion can
 *  return a complete CanvasDoc without threading them through the caller. */
function readCanvasHeader(artifactId: string): {
	conversationId: string;
	title: string | null;
	kind: 'markdown';
} {
	const db = getDb();
	const row = db
		.select({
			conversationId: artifacts.conversationId,
			title: artifacts.title,
			kind: artifacts.kind,
		})
		.from(artifacts)
		.where(eq(artifacts.id, artifactId))
		.get();
	return {
		conversationId: row?.conversationId ?? '',
		title: row?.title ?? null,
		kind: 'markdown',
	};
}
