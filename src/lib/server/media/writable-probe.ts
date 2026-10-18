/**
 * Boot-time check that the media and derived directories are writable.
 *
 * The image runs as uid 1000, and a directory an older root-run container
 * created (a separate media mount, a NAS share) stays root-owned. Nothing would
 * say so: an upload fails as a bare 500, a generated image as a raw EACCES in
 * the chat, and thumbnails just stop appearing. The database gets the same
 * explanation from `explainUnwritableDb` (db/client.ts).
 *
 * A real write, not `access(W_OK)`, which an NFS root_squash or idmapped mount
 * can answer wrongly. It only logs: a network share that is briefly down at
 * boot must not crash-loop the server.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { derivedDir, mediaDir } from '../env';
import { createLogger } from '../log';

const log = createLogger('storage');

export async function probeMediaDirsWritable(
	dirs: Array<[label: string, dir: string]> = [
		['MEDIA_DIR', mediaDir()],
		['DERIVED_DIR', derivedDir()],
	],
): Promise<void> {
	const seen = new Set<string>();
	for (const [label, dir] of dirs) {
		const abs = resolve(dir);
		if (seen.has(abs)) continue;
		seen.add(abs);
		const probe = join(abs, `.write-probe-${randomUUID()}`);
		try {
			await mkdir(abs, { recursive: true });
			await writeFile(probe, '');
			await unlink(probe);
		} catch (e) {
			const uid = process.getuid?.();
			// The running ids, not the image's default: the image also runs under
			// an operator-chosen uid (docs/deployment.md), and a chown to 1000
			// would be the wrong fix there.
			const owner = `${uid ?? 1000}:${process.getgid?.() ?? 1000}`;
			log.error(
				`${label} (${abs}) is not writable by uid ${uid ?? '?'}: ` +
					`${e instanceof Error ? e.message : String(e)}. Uploads and generated ` +
					`media will fail until it is, e.g. \`sudo chown -R ${owner} <that dir>\` ` +
					`on the host for the Docker image (on an NFS share, on the server).`,
			);
		}
	}
}
