/**
 * Background worker that populates `memories.embedding` (for `recall_memory`)
 * and `media.embedding` (for semantic gallery prompt search) so both have
 * vectors to rank against.
 *
 * Rows are saved without an embedding (the write path stays a single fast
 * INSERT, and the embedding endpoint may be down at write time); this sweep
 * fills them in asynchronously. It also re-embeds rows whose stored
 * `embedding_model` no longer matches the configured one (operator changed the
 * model) and memory rows whose content was edited (updateMemory nulls the vector).
 *
 * Mirrors the media purger's shape: a recursive setTimeout tick with a `running`
 * re-entrancy guard, an idempotent start, and a directly-callable sweep for
 * tests. When no `[embeddings]` block is configured there's nothing to embed,
 * so the worker doesn't even mount a timer.
 *
 * Like the `…NeedingEmbedding` queries, the sweep reads across all users — it's a
 * background job, not a request path, so the per-user read-isolation invariant
 * doesn't apply.
 */

import { embeddings } from '../endpoints/client';
import type { RelevanceConfig } from '../retrieval/embed-rank';
import { resolveRelevanceConfig } from '../retrieval/embeddings-config';
import { inputCharCap, truncate } from '../retrieval/embed-rank';
import { encodeVector } from '../retrieval/vector';
import { listMemoriesNeedingEmbedding, setMemoryEmbedding } from '../db/queries/memories';
import { listMediaNeedingEmbedding, setMediaEmbedding } from '../db/queries/media';

// Rows per /embeddings request. Kept small to stay within the per-request batch
// ceilings embedding backends (notably llama-server) enforce — memories are
// capped at 500 chars, so 8 rows is well under a typical char/item limit.
const BATCH_SIZE = 8;
// Backstop so one sweep can't loop forever if a row persistently fails to
// embed; the next tick retries. 8 × 50 = up to 400 memories drained per sweep.
const MAX_BATCHES_PER_SWEEP = 50;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Long enough for the DB connection to warm after boot; short enough that a
// fresh import gets embedded promptly.
const INITIAL_DELAY_MS = 15_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Drain one work queue (memories or media prompts) for a sweep. `fetchBatch`
 * returns up to `n` rows as `{ id, text }`; `persist` writes a computed vector
 * back (guarded on the text, returns true iff it took). Returns how many were
 * embedded. Generic so the memory and media queues share the batch/pairing/
 * poison-row logic.
 */
async function drainQueue(
	cfg: RelevanceConfig,
	label: string,
	fetchBatch: (n: number) => Array<{ id: string; text: string }>,
	persist: (id: string, text: string, blob: Buffer) => boolean,
): Promise<number> {
	const inputCap = inputCharCap(cfg.maxInputTokens);
	let embedded = 0;
	for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch++) {
		const rows = fetchBatch(BATCH_SIZE);
		if (rows.length === 0) break;

		let resp;
		try {
			resp = await embeddings(
				cfg.endpoint,
				{
					model: cfg.modelId,
					input: rows.map((r) => cfg.documentPrefix + truncate(r.text, inputCap)),
				},
				AbortSignal.timeout(cfg.timeoutSeconds * 1000),
			);
		} catch (e) {
			// Endpoint down / timeout — leave the rows for the next sweep.
			console.warn(`[${label}-backfill] embedding request failed, retrying next sweep:`, e);
			break;
		}

		const data = resp.data;
		if (!Array.isArray(data)) {
			console.warn(`[${label}-backfill] non-array embeddings response; retrying next sweep`);
			break;
		}
		// Pair returned vectors to rows by their response `index` (we sent one
		// input per row, in row order). Write each valid one individually rather
		// than discarding the whole batch on a count mismatch — a short or
		// reordered response still persists the vectors that did come back, so a
		// poison row can't starve the rows behind it.
		const vecByIndex = new Map<number, number[]>();
		for (const d of data) {
			const v = d.embedding;
			if (typeof d.index === 'number' && Array.isArray(v) && v.length > 0) {
				vecByIndex.set(d.index, v as number[]);
			}
		}

		let progressed = 0;
		for (let i = 0; i < rows.length; i++) {
			const vec = vecByIndex.get(i);
			if (!vec) continue;
			// Guarded on the text we read above; a no-match means a concurrent edit
			// nulled the vector mid-flight — leave it for the next sweep.
			if (persist(rows[i].id, rows[i].text, encodeVector(vec))) {
				embedded++;
				progressed++;
			}
		}
		// Nothing in this batch took — stop rather than re-query the same
		// unembeddable rows forever within one sweep.
		if (progressed === 0) break;
	}
	return embedded;
}

/**
 * Run one backfill pass over both the memory and media-prompt queues. Returns
 * the total embedded so tests can assert. No-op (returns 0) when embeddings
 * aren't configured or a sweep is already running. Safe to call directly
 * alongside the periodic timer.
 */
export async function runBackfillSweep(): Promise<{ embedded: number }> {
	if (running) return { embedded: 0 };
	running = true;
	try {
		const cfg = resolveRelevanceConfig();
		if (!cfg) return { embedded: 0 };

		let embedded = 0;
		embedded += await drainQueue(
			cfg,
			'memory',
			(n) =>
				listMemoriesNeedingEmbedding(cfg.modelId, n).map((r) => ({ id: r.id, text: r.content })),
			(id, text, blob) => setMemoryEmbedding(id, text, blob, cfg.modelId),
		);
		embedded += await drainQueue(
			cfg,
			'media',
			(n) =>
				listMediaNeedingEmbedding(cfg.modelId, n).map((r) => ({ id: r.id, text: r.promptFull })),
			(id, text, blob) => setMediaEmbedding(id, text, blob, cfg.modelId),
		);

		if (embedded > 0) console.log(`[embedding-backfill] sweep done: embedded=${embedded}`);
		return { embedded };
	} finally {
		running = false;
	}
}

/**
 * Mount the periodic backfiller (memory + media-prompt embeddings). Idempotent.
 * No-op when no embedding model is configured — without one there are no vectors
 * to compute and recall/semantic-search are off, so a timer would just wake to
 * do nothing. (A config change needs a restart, which re-runs this.)
 */
export function startEmbeddingBackfiller(): void {
	if (timer) return;
	if (!resolveRelevanceConfig()) return;
	timer = setTimeout(function tick() {
		runBackfillSweep()
			.catch((e) => console.error('[embedding-backfill] sweep failed:', e))
			.finally(() => {
				timer = setTimeout(tick, SWEEP_INTERVAL_MS);
				timer?.unref();
			});
	}, INITIAL_DELAY_MS);
	timer?.unref();
	console.log(`[embedding-backfill] started; sweep every ${SWEEP_INTERVAL_MS / 60000}min`);
}

/** Tear down the timer — for tests / clean shutdown. */
export function stopEmbeddingBackfiller(): void {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}
