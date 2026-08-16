/**
 * Two activations of the same control within a short window, treated as one
 * "double activate".
 *
 * Extracted rather than inlined at its one call site because that call site is
 * the *only* entry point to something deliberately hidden (the debug panel
 * behind the sidebar version number). A hidden affordance that silently stops
 * working is exactly the failure this codebase keeps getting bitten by — no
 * user reports it, because no user knows it's there.
 *
 * Counts `click` rather than listening for `dblclick`, which buys two things:
 * a keyboard user pressing Enter twice on the focused control gets in (Enter
 * fires click), and it doesn't depend on WebKit synthesising `dblclick` from a
 * double tap — the iOS PWA being the device this is for.
 */
export function createDoubleActivate(onDouble: () => void, windowMs = 450): () => void {
	let previous = 0;
	return () => {
		const now = Date.now();
		if (previous !== 0 && now - previous < windowMs) {
			// Reset rather than carry the timestamp forward, so a third click
			// starts a fresh pair instead of firing again immediately.
			previous = 0;
			onDouble();
			return;
		}
		previous = now;
	};
}
