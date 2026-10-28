/**
 * Watching photos that are developing, for a page that may have lost the
 * stream it started them with — or never had one (a reload mid-draw).
 *
 * A photo draw is a background job the server owns; the page learns of a
 * result by reloading. The tab that started a draw reloads when its stream
 * ends, but iOS suspends a backgrounded PWA and kills that stream within
 * seconds of a draw that takes minutes, and a reloaded page has no stream at
 * all. So while the page's own data says photos are developing, this asks the
 * server how many still are (`GET …/photos?messages=…`, a count) — every few
 * seconds while visible, and at once on the two halves of an app resume and on
 * coming back online — and reloads once that count drops. The reload brings
 * new data, which re-arms or retires the watch.
 */

const POLL_MS = 5_000;

export interface DevelopWatch {
	conversationId: string;
	/** The replies on screen with photos developing. */
	replyIds: string[];
	/** How many draws the page's data says are out for them. */
	expected: number;
	/** Pull fresh data: the chat page's `refreshAll`. */
	refresh: () => Promise<unknown>;
}

/** Start watching; returns the stop. */
export function watchDevelopingPhotos(watch: DevelopWatch): () => void {
	let stopped = false;
	let checking = false;
	const url = `/api/conversations/${watch.conversationId}/photos?messages=${watch.replyIds.join(',')}`;

	async function check(): Promise<void> {
		if (stopped || checking || document.visibilityState !== 'visible') return;
		checking = true;
		try {
			const res = await fetch(url);
			if (!res.ok || stopped) return;
			const { developing } = (await res.json()) as { developing: number };
			if (developing < watch.expected && !stopped) {
				stopped = true;
				await watch.refresh();
			}
		} catch {
			// Offline or a blip: the next tick, or coming back online, asks again.
		} finally {
			checking = false;
		}
	}

	const timer = setInterval(() => void check(), POLL_MS);
	const onVisible = () => void check();
	const onPageShow = (e: PageTransitionEvent) => {
		if (e.persisted) void check();
	};
	document.addEventListener('visibilitychange', onVisible);
	window.addEventListener('pageshow', onPageShow);
	window.addEventListener('online', onVisible);
	return () => {
		stopped = true;
		clearInterval(timer);
		document.removeEventListener('visibilitychange', onVisible);
		window.removeEventListener('pageshow', onPageShow);
		window.removeEventListener('online', onVisible);
	};
}
