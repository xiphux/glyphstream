/**
 * Ask a service worker which build it is.
 *
 * The worker answers `GET_BUILD` over the caller's port (see service-worker.ts).
 * Resolves null when it doesn't answer — a worker from before GET_BUILD existed
 * won't, and neither will one that fails to boot.
 *
 * Two callers want this and they ask different workers: the root layout asks the
 * WAITING worker, to decide whether an update prompt is worth raising, and the
 * debug panel asks the CONTROLLING one, because "controlled" alone cannot say
 * whether the worker driving the page is the build the page came from.
 */
export function askWorkerBuild(worker: ServiceWorker, timeoutMs = 1500): Promise<string | null> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		let settled = false;
		// Single settle path, matching queryClient in service-worker.ts — the
		// mirror image of this call. Nothing misbehaves without it (a second
		// resolve is a no-op), but the two are a pair and an asymmetry here
		// only makes a reader wonder which one is right.
		const finish = (build: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			channel.port1.onmessage = null;
			resolve(build);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		channel.port1.onmessage = (ev: MessageEvent) => {
			finish(typeof ev.data === 'string' ? ev.data : null);
		};
		try {
			worker.postMessage({ type: 'GET_BUILD' }, [channel.port2]);
		} catch {
			finish(null);
		}
	});
}
