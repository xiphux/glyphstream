/**
 * Observe a sentinel element's visibility within a scroll container — the shared
 * IntersectionObserver wiring behind the gallery's infinite scroll and the chat
 * page's "near bottom" auto-stick. A bottom-edge `rootMargin` turns it into a
 * prefetch / tolerance zone (the observer reports "intersecting" before the
 * sentinel is actually on screen).
 *
 * Returns a cleanup that disconnects the observer — call it from a Svelte
 * `$effect` and return the result, so re-running (root/sentinel changed) or
 * teardown disconnects cleanly. A no-op cleanup is returned when either element
 * is missing, so callers don't repeat the null guard.
 */
export function observeSentinel(
	root: HTMLElement | null,
	sentinel: HTMLElement | null,
	onVisible: (visible: boolean) => void,
	opts: { rootMargin?: string } = {},
): () => void {
	if (!root || !sentinel) return () => {};
	const observer = new IntersectionObserver(([entry]) => onVisible(entry.isIntersecting), {
		root,
		rootMargin: opts.rootMargin ?? '0px',
		threshold: 0,
	});
	observer.observe(sentinel);
	return () => observer.disconnect();
}
