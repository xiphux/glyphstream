/**
 * Reactive flag: is the CURRENTLY-VISIBLE view a private chat?
 *
 * Drives the incognito re-tint — the `[data-private]` attribute on <html> that
 * app.css keys the violet surface/accent overrides off. Publishing is split from
 * applying: the pages that know they're private set `active` (the new-chat screen
 * from its toggle; the chat page from the loaded conversation's `private` flag)
 * and clear it when they unmount, while a single `$effect` in the (app) layout
 * owns the actual DOM mutation. That keeps the attribute logic in one place and
 * lets it clear cleanly when navigating to a non-private view (settings, a normal
 * chat) whose page never sets `active`.
 */
class PrivateView {
	active = $state(false);
}

export const privateView = new PrivateView();
