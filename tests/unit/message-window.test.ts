/**
 * A refresh brings back only the newest window of the branch; the older
 * messages the user already scrolled up to load must survive it — unless the
 * branch changed above the window.
 */
import { describe, expect, it } from 'vitest';
import { mergeRefreshedWindow } from '#lib/message-window.js';
import type { ChatMessage } from '#lib/types/api.js';

const msg = (id: string, text = id) =>
	({ id, role: 'user', parts: [{ type: 'text', text }], createdAt: 0 }) as ChatMessage;
const ids = (ms: ChatMessage[]) => ms.map((m) => m.id);

describe('mergeRefreshedWindow', () => {
	it('keeps the older messages above a refreshed window that overlaps them', () => {
		const current = ['a', 'b', 'c', 'd'].map((i) => msg(i));
		const fresh = [msg('c', 'c (fresh)'), msg('d'), msg('e')];
		const out = mergeRefreshedWindow(current, fresh);
		expect(out.keptEarlier).toBe(true);
		expect(ids(out.messages)).toEqual(['a', 'b', 'c', 'd', 'e']);
		// The window's own rows come from the refresh.
		expect(out.messages[2]).toBe(fresh[0]);
	});

	it('replaces the list when the branch changed above the window', () => {
		const current = ['a', 'b', 'c'].map((i) => msg(i));
		const out = mergeRefreshedWindow(current, [msg('x'), msg('y')]);
		expect(out).toEqual({ messages: [msg('x'), msg('y')], keptEarlier: false });
	});

	it('takes the refresh as-is when it already starts at the top of the list', () => {
		const current = ['a', 'b'].map((i) => msg(i));
		const fresh = ['a', 'b', 'c'].map((i) => msg(i));
		expect(mergeRefreshedWindow(current, fresh)).toEqual({ messages: fresh, keptEarlier: false });
	});

	it('takes an empty refresh as-is', () => {
		expect(mergeRefreshedWindow([msg('a')], [])).toEqual({ messages: [], keptEarlier: false });
	});
});
