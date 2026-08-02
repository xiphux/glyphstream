/**
 * Thumbnail generation is lazy and disk-cached, so the miss path only runs on a
 * library's first view — but that's exactly when a virtualized gallery asks for
 * 30-60 tiles at once. Every one of those was starting an independent `sharp`
 * pipeline: dozens of concurrent libvips decodes of multi-MB PNGs competing for
 * sharp's own thread pool, at first paint. Two requests for the same id also
 * both generated, and both wrote the same path with no tmp+rename, racing on the
 * output file.
 *
 * These tests pin the two properties that fix it: identical requests share one
 * generation, and generations are globally capped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const state = vi.hoisted(() => ({
	root: '',
	/** Resolves the currently-running sharp jobs; lets a test hold them open. */
	pending: [] as Array<() => void>,
	started: 0,
	peakConcurrent: 0,
	live: 0,
}));

vi.mock('$lib/server/env', () => ({ mediaDir: () => state.root }));

vi.mock('sharp', () => {
	const makeChain = (outPath: { value: string }) => {
		const chain = {
			resize: () => chain,
			jpeg: () => chain,
			toFile: (p: string) => {
				outPath.value = p;
				state.started++;
				state.live++;
				state.peakConcurrent = Math.max(state.peakConcurrent, state.live);
				return new Promise<void>((res) => {
					state.pending.push(() => {
						mkdirSync(dirname(p), { recursive: true });
						writeFileSync(p, 'jpeg-bytes');
						state.live--;
						res();
					});
				});
			},
		};
		return chain;
	};
	return { default: () => makeChain({ value: '' }) };
});

import { getOrCreateThumbnail } from '$lib/server/media/thumbnail';

/**
 * Let queued sharp jobs finish. Polls rather than draining once: a job only
 * reaches the mocked `toFile` after several awaits (stat, semaphore, re-stat),
 * and the semaphore admits later jobs only as earlier ones release, so the
 * queue refills between ticks.
 */
async function drain(ticks = 200) {
	for (let i = 0; i < ticks; i++) {
		const batch = state.pending.splice(0);
		for (const release of batch) release();
		await new Promise((r) => setTimeout(r, 0));
		if (batch.length === 0 && state.live === 0 && state.pending.length === 0 && i > 5) return;
	}
}

function seedSource(relPath: string) {
	const abs = resolve(state.root, relPath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, 'png-bytes');
}

beforeEach(() => {
	state.root = mkdtempSync(join(tmpdir(), 'gs-thumb-'));
	state.pending = [];
	state.started = 0;
	state.peakConcurrent = 0;
	state.live = 0;
});

afterEach(() => {
	rmSync(state.root, { recursive: true, force: true });
});

describe('getOrCreateThumbnail', () => {
	it('collapses concurrent requests for the same media into one generation', async () => {
		seedSource('ab/cd/one.png');
		const all = Promise.all(Array.from({ length: 8 }, () => getOrCreateThumbnail('ab/cd/one.png')));
		await new Promise((r) => setTimeout(r, 0));
		await drain();
		const results = await all;

		expect(state.started, 'each concurrent request started its own sharp pipeline').toBe(1);
		// Every caller still gets a usable ref.
		for (const r of results) {
			expect(r).not.toBeNull();
			expect(r!.contentType).toBe('image/jpeg');
		}
	});

	it('caps how many generations run at once across different media', async () => {
		for (let i = 0; i < 12; i++) seedSource(`ab/cd/m${i}.png`);
		const all = Promise.all(
			Array.from({ length: 12 }, (_, i) => getOrCreateThumbnail(`ab/cd/m${i}.png`)),
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(
			state.peakConcurrent,
			'a burst of misses ran unbounded sharp pipelines',
		).toBeLessThanOrEqual(3);
		await drain();
		const results = await all;
		expect(results.every((r) => r !== null)).toBe(true);
		expect(state.started).toBe(12);
	});

	it('serves the cached file without regenerating', async () => {
		seedSource('ab/cd/two.png');
		const first = getOrCreateThumbnail('ab/cd/two.png');
		await new Promise((r) => setTimeout(r, 0));
		await drain();
		await first;
		expect(state.started).toBe(1);

		const second = await getOrCreateThumbnail('ab/cd/two.png');
		expect(second).not.toBeNull();
		expect(state.started, 'a cache hit re-ran sharp').toBe(1);
	});

	it('returns null when the source is missing, without generating', async () => {
		expect(await getOrCreateThumbnail('ab/cd/absent.png')).toBeNull();
		expect(state.started).toBe(0);
	});

	it('leaves no temp files behind', async () => {
		seedSource('ab/cd/three.png');
		const p = getOrCreateThumbnail('ab/cd/three.png');
		await new Promise((r) => setTimeout(r, 0));
		await drain();
		await p;
		const dir = resolve(state.root, 'ab/cd');
		const leftovers = existsSync(dir)
			? (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.tmp'))
			: [];
		expect(leftovers).toEqual([]);
	});
});
