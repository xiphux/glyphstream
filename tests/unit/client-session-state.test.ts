/* @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// happy-dom here supplies window/document but not localStorage; install a
// minimal in-memory shim. `browser: true` makes the module take the live path.
vi.mock('$app/environment', () => ({ browser: true }));

const store = new Map<string, string>();
const localStorageShim: Storage = {
	get length() {
		return store.size;
	},
	clear: () => store.clear(),
	getItem: (k) => (store.has(k) ? store.get(k)! : null),
	setItem: (k, v) => void store.set(k, String(v)),
	removeItem: (k) => void store.delete(k),
	key: (i) => [...store.keys()][i] ?? null,
};
vi.stubGlobal('localStorage', localStorageShim);

import { clearSessionScopedClientState } from '$lib/client-session-state';

beforeEach(() => {
	localStorage.clear();
});

describe('clearSessionScopedClientState', () => {
	it('removes every glyphstream: localStorage key (drafts + sidebar)', () => {
		localStorage.setItem('glyphstream:composerDraft:new', '{"text":"x","savedAt":1}');
		localStorage.setItem('glyphstream:composerDraft:conv-1', '{"text":"y","savedAt":1}');
		localStorage.setItem('glyphstream:sidebarCollapsed', '1');

		clearSessionScopedClientState();

		expect(localStorage.getItem('glyphstream:composerDraft:new')).toBeNull();
		expect(localStorage.getItem('glyphstream:composerDraft:conv-1')).toBeNull();
		expect(localStorage.getItem('glyphstream:sidebarCollapsed')).toBeNull();
		expect(localStorage.length).toBe(0);
	});

	it('leaves keys outside the glyphstream: namespace untouched', () => {
		localStorage.setItem('glyphstream:sidebarCollapsed', '1');
		localStorage.setItem('some-other-app:key', 'value');
		localStorage.setItem('unprefixed', 'keep');

		clearSessionScopedClientState();

		expect(localStorage.getItem('glyphstream:sidebarCollapsed')).toBeNull();
		expect(localStorage.getItem('some-other-app:key')).toBe('value');
		expect(localStorage.getItem('unprefixed')).toBe('keep');
	});

	it('is a no-op when there is nothing to clear', () => {
		expect(() => clearSessionScopedClientState()).not.toThrow();
		expect(localStorage.length).toBe(0);
	});
});
