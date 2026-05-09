import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../client';
import { media, messageMedia } from '../schema';

export interface MediaInsertInput {
	userId: string;
	storagePath: string;
	contentType: string;
	byteSize: number;
	kind: 'image' | 'video';
	sourceEndpointId: string | null;
	sourceModel: string | null;
	promptExcerpt: string | null;
}

/** Insert a fresh media row (ref_count = 0; caller links it via linkMessageMedia). */
export function insertMedia(input: MediaInsertInput): { id: string } {
	const db = getDb();
	const id = randomUUID();
	db.insert(media)
		.values({
			id,
			userId: input.userId,
			storagePath: input.storagePath,
			contentType: input.contentType,
			byteSize: input.byteSize,
			kind: input.kind,
			sourceEndpointId: input.sourceEndpointId,
			sourceModel: input.sourceModel,
			promptExcerpt: input.promptExcerpt,
			createdAt: Date.now(),
			refCount: 0,
			unreferencedSince: null,
			hardDeletedAt: null
		})
		.run();
	return { id };
}

/** Link a media asset to a message and bump ref_count. Idempotent (PK on the join). */
export function linkMessageMedia(messageId: string, mediaId: string): void {
	const db = getDb();
	db.transaction((tx) => {
		const inserted = tx
			.insert(messageMedia)
			.values({ messageId, mediaId })
			.onConflictDoNothing()
			.run();
		if (inserted.changes > 0) {
			tx.update(media)
				.set({
					refCount: sql`${media.refCount} + 1`,
					unreferencedSince: null
				})
				.where(eq(media.id, mediaId))
				.run();
		}
	});
}

/** Look up a media row owned by `userId` (returns null on not-found / ownership mismatch). */
export function getMediaForUser(
	mediaId: string,
	userId: string
): {
	id: string;
	storagePath: string;
	contentType: string;
	byteSize: number;
	kind: 'image' | 'video';
	hardDeletedAt: number | null;
} | null {
	const db = getDb();
	const row = db
		.select({
			id: media.id,
			storagePath: media.storagePath,
			contentType: media.contentType,
			byteSize: media.byteSize,
			kind: media.kind,
			hardDeletedAt: media.hardDeletedAt
		})
		.from(media)
		.where(and(eq(media.id, mediaId), eq(media.userId, userId)))
		.get();
	return row ?? null;
}
