/**
 * Convert a stored media row into a base64 data URL for inlining into
 * upstream requests.
 *
 * Why data URLs instead of pass-through URLs: the upstream model server
 * (OpenAI, Anthropic, llama-server, the bridge) needs to actually fetch
 * the image. For self-hosted setups behind a NAS/reverse-proxy, it's
 * not always reachable from the upstream's perspective — and our
 * /api/media/:id/content endpoint is auth-gated anyway. Embedding the
 * bytes as a data URL works in every topology at the cost of a
 * larger payload (~33% base64 overhead). Optimization for "upstream is
 * on the same network, give it a signed URL" is a v2 concern.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mediaDir } from '../env';
import { getMediaForUser } from '../db/queries/media';

export async function mediaIdToDataUrl(mediaId: string, userId: string): Promise<string> {
	const row = getMediaForUser(mediaId, userId);
	if (!row) throw new Error(`Media ${mediaId} not found for user`);
	if (row.hardDeletedAt !== null) throw new Error(`Media ${mediaId} has been deleted`);
	const fullPath = resolve(mediaDir(), row.storagePath);
	const bytes = await readFile(fullPath);
	const b64 = bytes.toString('base64');
	return `data:${row.contentType};base64,${b64}`;
}
