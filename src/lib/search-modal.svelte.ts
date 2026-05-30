/**
 * App-wide search modal toggle.
 *
 * Singleton mirroring `confirmDialog` — a single <SearchModal> host
 * rendered in the (app) layout reads `searchModal.open` and renders the
 * Spotlight-style overlay. Callers (sidebar Search button, Cmd+K
 * shortcut) invoke `searchModal.show()` / `searchModal.hide()` without
 * having to thread state through props.
 *
 * Why a fire-and-forget singleton rather than the Promise-resolving
 * shape of confirmDialog: the search modal doesn't yield a value back
 * to a caller — the user picks a result, the modal navigates, the
 * modal closes. No await on the caller side.
 */

class SearchModalStore {
	open = $state(false);

	show(): void {
		this.open = true;
	}

	hide(): void {
		this.open = false;
	}

	toggle(): void {
		this.open = !this.open;
	}
}

export const searchModal = new SearchModalStore();
