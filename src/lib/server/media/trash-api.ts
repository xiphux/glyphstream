import { error } from '@sveltejs/kit';
import type { TrashedMediaRow } from '../db/queries/media';
import type { TrashedMediaItem } from '$lib/types/api';
import { TRASH_RETENTION_MS } from './trash';

/** Same ceiling as the gallery's bulk delete, so "select everything, restore"
 *  round-trips whatever a bulk delete put there. */
export const MAX_TRASH_IDS = 200;

/** Narrow a `{ ids: string[] }` body, 400ing on anything else. */
export function parseTrashIds(body: { ids?: unknown }): string[] {
	if (!Array.isArray(body.ids)) error(400, "'ids' must be an array of media id strings");
	const ids: string[] = [];
	for (const v of body.ids) {
		if (typeof v !== 'string' || v.length === 0) {
			error(400, "'ids' entries must be non-empty strings");
		}
		ids.push(v);
	}
	if (ids.length > MAX_TRASH_IDS) error(400, `Too many ids in one request (max ${MAX_TRASH_IDS})`);
	return ids;
}

export function toTrashedMediaItem(row: TrashedMediaRow): TrashedMediaItem {
	return { ...row, expiresAt: row.deletedAt + TRASH_RETENTION_MS };
}
