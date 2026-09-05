import { describe, expect, it } from 'vitest';
import {
	PENDING_NAV_CACHE,
	PENDING_NAV_KEY,
	PENDING_NAV_MAX_AGE_MS,
	PENDING_NAV_VERSION,
	askPendingNavigation,
	claimPendingNavigation,
	forgetPendingNavigation,
	isClaimable,
	recordPendingNavigation,
} from '$lib/sw/pending-navigation';

/** Minimal in-memory Cache Storage — enough of the surface the module uses. */
function fakeCaches(opts: { failOpen?: boolean } = {}) {
	const store = new Map<string, string>();
	const api = {
		store,
		open: async (_name: string) => {
			if (opts.failOpen) throw new Error('no cache storage');
			return {
				match: async (req: string) => {
					const body = store.get(req);
					return body === undefined ? undefined : { json: async () => JSON.parse(body) as unknown };
				},
				put: async (req: string, res: Response) => {
					store.set(req, await res.text());
				},
				delete: async (req: string) => store.delete(req),
			};
		},
	};
	return api;
}

describe('isClaimable', () => {
	it('accepts a record written just now', () => {
		expect(isClaimable({ v: PENDING_NAV_VERSION, conversationId: 'c1', at: 1000 }, 1000)).toBe(
			true,
		);
	});

	it('accepts a record right at the age limit', () => {
		expect(
			isClaimable({ v: PENDING_NAV_VERSION, conversationId: 'c1', at: 0 }, PENDING_NAV_MAX_AGE_MS),
		).toBe(true);
	});

	it('rejects a record past the age limit', () => {
		expect(
			isClaimable(
				{ v: PENDING_NAV_VERSION, conversationId: 'c1', at: 0 },
				PENDING_NAV_MAX_AGE_MS + 1,
			),
		).toBe(false);
	});

	it('rejects a record from the future (clock moved backwards)', () => {
		expect(isClaimable({ v: PENDING_NAV_VERSION, conversationId: 'c1', at: 5000 }, 1000)).toBe(
			false,
		);
	});
});

describe('record + claim', () => {
	it('round-trips the conversation id', async () => {
		const caches = fakeCaches();
		await recordPendingNavigation(caches, 'conv-42', 1000);
		expect(await claimPendingNavigation(caches, 1000)).toBe('conv-42');
	});

	it('is single-use — a second claim gets nothing', async () => {
		const caches = fakeCaches();
		await recordPendingNavigation(caches, 'conv-42', 1000);
		expect(await claimPendingNavigation(caches, 1000)).toBe('conv-42');
		expect(await claimPendingNavigation(caches, 1000)).toBeNull();
	});

	it('returns null when nothing was ever recorded', async () => {
		expect(await claimPendingNavigation(fakeCaches(), 1000)).toBeNull();
	});

	it('refuses a stale target and consumes it, so it cannot lie in wait', async () => {
		// The case this bound exists for: a tap whose launch never arrived must
		// not hijack an unrelated app open hours later.
		const caches = fakeCaches();
		await recordPendingNavigation(caches, 'conv-42', 0);
		expect(await claimPendingNavigation(caches, PENDING_NAV_MAX_AGE_MS + 1)).toBeNull();
		expect(caches.store.has(PENDING_NAV_KEY)).toBe(false);
	});

	it('the newest tap wins when two land before either is claimed', async () => {
		const caches = fakeCaches();
		await recordPendingNavigation(caches, 'conv-1', 1000);
		await recordPendingNavigation(caches, 'conv-2', 2000);
		expect(await claimPendingNavigation(caches, 2000)).toBe('conv-2');
	});

	it('ignores a malformed record rather than navigating somewhere odd', async () => {
		const caches = fakeCaches();
		caches.store.set(
			PENDING_NAV_KEY,
			JSON.stringify({ v: PENDING_NAV_VERSION, conversationId: '', at: 1000 }),
		);
		expect(await claimPendingNavigation(caches, 1000)).toBeNull();
	});

	it('rejects a record of a different shape version, and still consumes it', async () => {
		// A record can outlive a worker update that lands between the tap and the
		// launch, so the two sides can genuinely disagree about the shape. Reject
		// rather than structurally misread — but delete regardless, so a rejected
		// record can't be re-read on every launch until it expires.
		const caches = fakeCaches();
		caches.store.set(
			PENDING_NAV_KEY,
			JSON.stringify({ v: PENDING_NAV_VERSION + 1, conversationId: 'conv-42', at: 1000 }),
		);
		expect(await claimPendingNavigation(caches, 1000)).toBeNull();
		expect(caches.store.has(PENDING_NAV_KEY)).toBe(false);
	});

	it('rejects a record written before versioning existed', async () => {
		const caches = fakeCaches();
		caches.store.set(PENDING_NAV_KEY, JSON.stringify({ conversationId: 'conv-42', at: 1000 }));
		expect(await claimPendingNavigation(caches, 1000)).toBeNull();
		expect(caches.store.has(PENDING_NAV_KEY)).toBe(false);
	});

	it('stamps the current version on every record it writes', async () => {
		const caches = fakeCaches();
		await recordPendingNavigation(caches, 'conv-42', 1000);
		const stored = JSON.parse(caches.store.get(PENDING_NAV_KEY) ?? '{}') as { v?: number };
		expect(stored.v).toBe(PENDING_NAV_VERSION);
	});

	it('forgetting drops the whole cache, so it cannot outlive a sign-out', async () => {
		const deleted: string[] = [];
		const caches = { delete: async (name: string) => (deleted.push(name), true) };
		await forgetPendingNavigation(caches);
		expect(deleted).toEqual([PENDING_NAV_CACHE]);
	});

	it('forgetting never throws when Cache Storage refuses', async () => {
		const caches = {
			delete: async () => {
				throw new Error('no cache storage');
			},
		};
		await expect(forgetPendingNavigation(caches)).resolves.toBeUndefined();
	});

	it('never throws when Cache Storage is unavailable', async () => {
		const caches = fakeCaches({ failOpen: true });
		await expect(recordPendingNavigation(caches, 'conv-42', 1000)).resolves.toBeUndefined();
		await expect(claimPendingNavigation(caches, 1000)).resolves.toBeNull();
	});
});

/** Stands in for the controlling ServiceWorker: hands the transferred reply
 *  port to `respond` instead of actually crossing a worker boundary. */
function fakeWorker(respond: (port: MessagePort) => void): ServiceWorker {
	return {
		postMessage: (_msg: unknown, transfer: Transferable[]) => {
			respond(transfer[0] as MessagePort);
		},
	} as unknown as ServiceWorker;
}

describe('askPendingNavigation', () => {
	it('resolves the id the worker answers with', async () => {
		const worker = fakeWorker((port) => port.postMessage('conv-42'));
		expect(await askPendingNavigation(worker)).toBe('conv-42');
	});

	it('resolves null when the worker answers that nothing is pending', async () => {
		const worker = fakeWorker((port) => port.postMessage(null));
		expect(await askPendingNavigation(worker)).toBeNull();
	});

	it('resolves null when the worker never answers', async () => {
		// A worker from before CLAIM_PENDING_NAVIGATION existed — a real case
		// during the update window, and the reason this can't hang the boot.
		const worker = fakeWorker(() => {});
		expect(await askPendingNavigation(worker, 10)).toBeNull();
	});

	it('resolves null when postMessage throws', async () => {
		const worker = {
			postMessage: () => {
				throw new Error('worker is gone');
			},
		} as unknown as ServiceWorker;
		expect(await askPendingNavigation(worker, 10)).toBeNull();
	});
});
