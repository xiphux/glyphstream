/**
 * Disk-backed MediaStore. Writes to `${MEDIA_DIR}/{id[0:2]}/{id[2:4]}/{id}.{ext}`
 * with atomic rename from a sibling .tmp file.
 *
 * The two-level shard keeps any single directory from blowing past
 * file-system inode limits; the host FS deals with millions of media files
 * across thousands of dirs without slowing dirent lookup.
 */

import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mediaDir } from '../env';
import { thumbStoragePath } from './thumbnail';
import type {
	MediaOpenResult,
	MediaPutInput,
	MediaRange,
	MediaStore,
	MediaStoredRef
} from './store';

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov'
};

function extFor(contentType: string): string {
	return EXT_BY_CONTENT_TYPE[contentType.toLowerCase()] ?? 'bin';
}

function root(): string {
	const root = resolve(mediaDir());
	mkdirSync(root, { recursive: true });
	return root;
}

function pathFor(id: string, ext: string): string {
	return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.${ext}`;
}

export class DiskMediaStore implements MediaStore {
	async put(input: MediaPutInput): Promise<MediaStoredRef> {
		const id = randomUUID().replace(/-/g, '');
		const ext = extFor(input.contentType);
		const storagePath = pathFor(id, ext);
		const absolute = resolve(root(), storagePath);
		mkdirSync(dirname(absolute), { recursive: true });

		const tmp = `${absolute}.tmp`;
		await writeFile(tmp, input.bytes);
		await rename(tmp, absolute);
		return {
			storagePath,
			byteSize: input.bytes.byteLength,
			contentType: input.contentType
		};
	}

	async open(
		storagePath: string,
		contentType: string,
		range?: MediaRange
	): Promise<MediaOpenResult | null> {
		const absolute = resolve(root(), storagePath);
		if (!existsSync(absolute)) return null;
		const stats = await stat(absolute);
		const size = stats.size;

		if (range) {
			const start = Math.max(0, Math.min(range.start, size - 1));
			const end = Math.max(start, Math.min(range.end, size - 1));
			return {
				stream: createReadStream(absolute, { start, end }),
				contentLength: end - start + 1,
				contentRange: { start, end, total: size },
				contentType
			};
		}
		return {
			stream: createReadStream(absolute),
			contentLength: size,
			contentType
		};
	}

	async delete(storagePath: string): Promise<void> {
		const absolute = resolve(root(), storagePath);
		try {
			await unlink(absolute);
		} catch (e) {
			// missing is fine; anything else we ignore (best-effort)
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
				console.warn(`[disk-store] delete(${storagePath}) failed:`, e);
			}
		}
		// Also remove the lazy-generated thumbnail sibling, if there is
		// one. We don't track presence — just try to unlink and shrug
		// off ENOENT (most media won't have a thumb yet; uploaded media
		// never does). Without this, every hard-deleted image would
		// leak its `.thumb.jpg` to disk indefinitely.
		const thumbAbs = resolve(root(), thumbStoragePath(storagePath));
		try {
			await unlink(thumbAbs);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
				console.warn(`[disk-store] delete thumb of ${storagePath} failed:`, e);
			}
		}
	}
}

let cached: DiskMediaStore | null = null;
export function getMediaStore(): DiskMediaStore {
	if (!cached) cached = new DiskMediaStore();
	return cached;
}

/**
 * Best-effort disk unlink for a batch of media files whose DB rows have
 * already been removed/hard-deleted. Run this *after* the DB transaction
 * that orphaned them commits — file unlinks aren't transactional, so
 * doing them inside a txn would let a rollback strand files deleted from
 * disk but still referenced from the DB.
 *
 * Per-file failures are swallowed with a warning: a leaked file with no
 * DB row is invisible to the app and reconcilable later, whereas throwing
 * here would turn an otherwise-successful delete into a 500. `logTag`
 * identifies the calling endpoint in the warning line. Centralizing this
 * keeps "is a failed unlink fatal?" a single decision shared by every
 * delete endpoint.
 */
export async function unlinkMediaFiles(
	files: ReadonlyArray<{ id: string; storagePath: string }>,
	logTag: string
): Promise<void> {
	if (files.length === 0) return;
	const store = getMediaStore();
	await Promise.all(
		files.map(async (m) => {
			try {
				await store.delete(m.storagePath);
			} catch (e) {
				console.warn(
					`[${logTag}] failed to unlink media ${m.id} at ${m.storagePath}:`,
					e
				);
			}
		})
	);
}
