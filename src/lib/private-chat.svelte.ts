/**
 * Reactive state for the CURRENTLY-VISIBLE private chat, shared between the pages
 * that know they're private and the (app) layout that chromes them.
 *
 * Two consumers, both in the layout:
 *   - the incognito re-tint — the `[data-private]` attribute on <html> that app.css
 *     keys the violet surface/accent overrides off (driven by `active`);
 *   - the mobile top bar's private control — a toggle on the new-chat screen
 *     (`toggleable` + `onToggle`) or a read-only badge in an open private chat.
 *
 * Publishing is split from applying: the private pages set these fields (the
 * new-chat screen from its toggle; the chat page from the loaded conversation) and
 * clear them on unmount, so navigating to a non-private view (settings, a normal
 * chat) drops both the re-tint and the top-bar control automatically.
 *
 * The desktop placements stay page-owned (the new-chat screen's corner toggle, the
 * ChatHeader badge); only the MOBILE control lives in the layout top bar, because
 * on mobile that row is the natural home — otherwise the control sits crooked on
 * its own row and eats the chat title's width.
 */
class PrivateView {
	/** Is the current view a private chat? Drives the `[data-private]` re-tint and
	 *  the read-only mobile badge. */
	active = $state(false);
	/** Does the current view let you TOGGLE private (i.e. the new-chat screen)? When
	 *  true the mobile top bar shows an interactive toggle instead of a badge. */
	toggleable = $state(false);
	/** The toggle handler the new-chat screen publishes, invoked by the mobile
	 *  top-bar toggle. Null when the current view isn't toggleable. */
	onToggle = $state<(() => void) | null>(null);

	/** Reset to the neutral (non-private, non-toggleable) state — called from each
	 *  private page's effect cleanup so a later view never inherits stale control. */
	reset() {
		this.active = false;
		this.toggleable = false;
		this.onToggle = null;
	}
}

export const privateView = new PrivateView();
