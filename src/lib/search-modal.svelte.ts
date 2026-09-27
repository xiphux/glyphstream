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

	/**
	 * iOS raises the keyboard for a programmatic `focus()` only inside the
	 * user gesture that caused it. The modal is lazy-imported, so on the first
	 * open of a session its input mounts a network round trip after the tap
	 * and the focus is silently refused (later opens resolve the cached module
	 * within the gesture's microtasks, which is why only a cold launch showed
	 * it). So `show()` focuses this invisible stand-in synchronously, inside the
	 * gesture, and the modal moves focus onto its real input once mounted —
	 * iOS does allow focus to hop from one text field to another. 16px so the
	 * stand-in doesn't trigger iOS's focus zoom either.
	 */
	#focusProxy: HTMLInputElement | null = null;

	show(): void {
		if (!this.open) this.#raiseFocusProxy();
		this.open = true;
	}

	hide(): void {
		this.releaseFocusProxy();
		this.open = false;
	}

	toggle(): void {
		if (this.open) this.hide();
		else this.show();
	}

	/**
	 * Called by the modal after focusing its input. Returns whatever was typed
	 * into the stand-in while the modal was still loading, so no keystroke is
	 * lost.
	 */
	releaseFocusProxy(): string {
		const proxy = this.#focusProxy;
		if (!proxy) return '';
		this.#focusProxy = null;
		proxy.remove();
		return proxy.value;
	}

	#raiseFocusProxy(): void {
		if (typeof document === 'undefined') return;
		this.releaseFocusProxy();
		const proxy = document.createElement('input');
		proxy.type = 'text';
		proxy.tabIndex = -1;
		proxy.setAttribute('aria-hidden', 'true');
		// Fixed at the top so focusing it doesn't scroll the page; not
		// `display:none`/`visibility:hidden`, which iOS won't focus.
		proxy.style.cssText =
			'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;pointer-events:none;';
		document.body.appendChild(proxy);
		proxy.focus();
		this.#focusProxy = proxy;
	}
}

export const searchModal = new SearchModalStore();
