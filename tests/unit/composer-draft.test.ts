/* @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module early-returns unless it believes it's running in the browser.
// happy-dom here supplies window/document but not localStorage, so install a
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

import {
	loadDraft,
	saveDraft,
	clearDraft,
	clearAllDrafts,
	createDraftWriter,
} from '$lib/composer-draft';

const key = (conv: string | null) => `glyphstream:composerDraft:${conv ?? 'new'}`;

beforeEach(() => {
	localStorage.clear();
});

describe('saveDraft / loadDraft / clearDraft', () => {
	it('round-trips a draft for a conversation', () => {
		saveDraft('conv-1', 'half a thought');
		expect(loadDraft('conv-1')).toBe('half a thought');
	});

	it('keys the new-chat box (null) separately from conversations', () => {
		saveDraft(null, 'new chat draft');
		saveDraft('conv-1', 'conv draft');
		expect(loadDraft(null)).toBe('new chat draft');
		expect(loadDraft('conv-1')).toBe('conv draft');
	});

	it('returns empty string when there is no draft', () => {
		expect(loadDraft('missing')).toBe('');
	});

	it('clearDraft removes a saved draft', () => {
		saveDraft('conv-1', 'text');
		clearDraft('conv-1');
		expect(loadDraft('conv-1')).toBe('');
	});

	it('saving empty / whitespace-only text removes the key', () => {
		saveDraft('conv-1', 'text');
		saveDraft('conv-1', '   ');
		expect(loadDraft('conv-1')).toBe('');
		// And the key is actually gone, not just blanked.
		expect(localStorage.getItem(key('conv-1'))).toBeNull();
	});

	it('drops and removes a draft older than the max age on load', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
			saveDraft('conv-1', 'stale');
			// Jump 8 days forward — past the 7-day TTL.
			vi.setSystemTime(new Date('2026-01-09T00:00:00Z'));
			expect(loadDraft('conv-1')).toBe('');
			expect(localStorage.getItem(key('conv-1'))).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps a draft that is within the max age', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
			saveDraft('conv-1', 'fresh');
			vi.setSystemTime(new Date('2026-01-03T00:00:00Z')); // 2 days later
			expect(loadDraft('conv-1')).toBe('fresh');
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats a malformed entry as absent and removes it', () => {
		localStorage.setItem(key('conv-1'), 'not json');
		expect(loadDraft('conv-1')).toBe('');
		expect(localStorage.getItem(key('conv-1'))).toBeNull();
	});
});

describe('clearAllDrafts', () => {
	it('removes every stored draft (new-chat + all conversations)', () => {
		saveDraft(null, 'new chat draft');
		saveDraft('conv-1', 'draft one');
		saveDraft('conv-2', 'draft two');

		clearAllDrafts();

		expect(loadDraft(null)).toBe('');
		expect(loadDraft('conv-1')).toBe('');
		expect(loadDraft('conv-2')).toBe('');
		expect(localStorage.length).toBe(0);
	});

	it('leaves unrelated localStorage keys untouched', () => {
		localStorage.setItem('glyphstream:sidebarCollapsed', '1');
		localStorage.setItem('some-other-app:key', 'value');
		saveDraft('conv-1', 'draft');

		clearAllDrafts();

		expect(loadDraft('conv-1')).toBe('');
		expect(localStorage.getItem('glyphstream:sidebarCollapsed')).toBe('1');
		expect(localStorage.getItem('some-other-app:key')).toBe('value');
	});
});

describe('createDraftWriter', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function hidePage() {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		});
		document.dispatchEvent(new Event('visibilitychange'));
	}

	it('debounces writes — only the latest value persists after the quiet window', () => {
		vi.useFakeTimers();
		const writer = createDraftWriter();

		writer.save('conv-1', 'a');
		writer.save('conv-1', 'ab');
		writer.save('conv-1', 'abc');

		// Nothing written yet — still inside the debounce window.
		expect(loadDraft('conv-1')).toBe('');

		vi.advanceTimersByTime(500);
		expect(loadDraft('conv-1')).toBe('abc');

		writer.dispose();
	});

	it('flushes the pending write immediately when the page is hidden', () => {
		vi.useFakeTimers();
		const writer = createDraftWriter();
		writer.save('conv-1', 'typed but not yet flushed');
		expect(loadDraft('conv-1')).toBe('');

		// Simulate iOS backgrounding the PWA before the debounce fires.
		hidePage();

		expect(loadDraft('conv-1')).toBe('typed but not yet flushed');
		writer.dispose();
	});

	it('commits a pending write for a previous conversation before debouncing a new one', () => {
		// The single composer is reused across conversation switches. A fast
		// client-side switch fires no page-hide, so the pending draft for the
		// conversation just left must be committed when the next save() targets a
		// different conversation — not stranded by the shared timer reschedule.
		vi.useFakeTimers();
		const writer = createDraftWriter();

		writer.save('conv-a', 'draft for A');
		// Switch to B (and B's restored draft) before A's debounce elapses.
		writer.save('conv-b', '');

		// A was flushed synchronously by the cross-conversation save.
		expect(loadDraft('conv-a')).toBe('draft for A');

		writer.save('conv-b', 'draft for B');
		vi.advanceTimersByTime(500);
		expect(loadDraft('conv-b')).toBe('draft for B');
		// A is untouched by B's writes.
		expect(loadDraft('conv-a')).toBe('draft for A');

		writer.dispose();
	});

	it('cancel() drops a pending write without persisting', () => {
		vi.useFakeTimers();
		const writer = createDraftWriter();
		writer.save('conv-1', 'discard me');
		writer.cancel();
		vi.advanceTimersByTime(500);
		expect(loadDraft('conv-1')).toBe('');
		// A page-hide after cancel has nothing to flush.
		hidePage();
		expect(loadDraft('conv-1')).toBe('');
		writer.dispose();
	});

	it('dispose() flushes a pending write, then detaches the page-hide listener', () => {
		vi.useFakeTimers();
		const writer = createDraftWriter();
		writer.save('conv-1', 'pending at teardown');

		// dispose() is the last chance to persist on a client-side route change
		// away from the composer (no page-hide fires), so it flushes.
		writer.dispose();
		expect(loadDraft('conv-1')).toBe('pending at teardown');

		// After dispose the listener is gone: a later hide writes nothing new.
		clearDraft('conv-1');
		hidePage();
		expect(loadDraft('conv-1')).toBe('');
	});
});
