/**
 * The Enter-key dispatch matrix for the message composer. Lives in one
 * place so the chat page, new-chat page, and inline edit all agree —
 * a divergence here would mean "Enter sends here but not there," which
 * is exactly the bug user preferences exist to prevent. The IME guard
 * is the one bit that's easy to forget and breaks Japanese/Chinese/
 * Korean input silently.
 */

import { describe, expect, it, vi } from 'vitest';
import { composerEnterHandler } from '$lib/composer-keys';

/** Minimal KeyboardEvent stub with the fields the handler reads + a
 *  preventDefault spy so we can assert the "consumed the key" contract. */
function makeKeyEvent(opts: {
	key?: string;
	isComposing?: boolean;
	shiftKey?: boolean;
	metaKey?: boolean;
	ctrlKey?: boolean;
}): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
	return {
		key: opts.key ?? 'Enter',
		isComposing: opts.isComposing ?? false,
		shiftKey: opts.shiftKey ?? false,
		metaKey: opts.metaKey ?? false,
		ctrlKey: opts.ctrlKey ?? false,
		preventDefault: vi.fn()
	} as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

describe('composerEnterHandler — send mode (default)', () => {
	it('bare Enter sends + preventDefault', () => {
		const onSend = vi.fn();
		const handler = composerEnterHandler('send', onSend);
		const e = makeKeyEvent({ key: 'Enter' });
		handler(e);
		expect(onSend).toHaveBeenCalledOnce();
		expect(e.preventDefault).toHaveBeenCalledOnce();
	});

	it('Shift+Enter lets the newline through (no send, no preventDefault)', () => {
		const onSend = vi.fn();
		const handler = composerEnterHandler('send', onSend);
		const e = makeKeyEvent({ key: 'Enter', shiftKey: true });
		handler(e);
		expect(onSend).not.toHaveBeenCalled();
		expect(e.preventDefault).not.toHaveBeenCalled();
	});

	it('ignores non-Enter keys entirely', () => {
		const onSend = vi.fn();
		const handler = composerEnterHandler('send', onSend);
		for (const key of ['a', 'Tab', 'ArrowDown', 'Backspace']) {
			const e = makeKeyEvent({ key });
			handler(e);
			expect(onSend).not.toHaveBeenCalled();
			expect(e.preventDefault).not.toHaveBeenCalled();
		}
	});

	it('skips during IME composition (isComposing=true)', () => {
		// Without this guard, pressing Enter to confirm a Japanese / Chinese
		// / Korean IME suggestion would prematurely send the message.
		const onSend = vi.fn();
		const handler = composerEnterHandler('send', onSend);
		const e = makeKeyEvent({ key: 'Enter', isComposing: true });
		handler(e);
		expect(onSend).not.toHaveBeenCalled();
		expect(e.preventDefault).not.toHaveBeenCalled();
	});
});

describe('composerEnterHandler — newline mode', () => {
	it('bare Enter lets the newline through', () => {
		const onSend = vi.fn();
		const handler = composerEnterHandler('newline', onSend);
		const e = makeKeyEvent({ key: 'Enter' });
		handler(e);
		expect(onSend).not.toHaveBeenCalled();
		expect(e.preventDefault).not.toHaveBeenCalled();
	});

	it('Cmd+Enter sends (macOS modifier)', () => {
		const onSend = vi.fn();
		const handler = composerEnterHandler('newline', onSend);
		const e = makeKeyEvent({ key: 'Enter', metaKey: true });
		handler(e);
		expect(onSend).toHaveBeenCalledOnce();
		expect(e.preventDefault).toHaveBeenCalledOnce();
	});

	it('Ctrl+Enter sends (Windows/Linux modifier)', () => {
		const onSend = vi.fn();
		const handler = composerEnterHandler('newline', onSend);
		const e = makeKeyEvent({ key: 'Enter', ctrlKey: true });
		handler(e);
		expect(onSend).toHaveBeenCalledOnce();
		expect(e.preventDefault).toHaveBeenCalledOnce();
	});

	it('Shift+Enter (no Cmd/Ctrl) does not send — only modifier-Enter does', () => {
		const onSend = vi.fn();
		const handler = composerEnterHandler('newline', onSend);
		const e = makeKeyEvent({ key: 'Enter', shiftKey: true });
		handler(e);
		expect(onSend).not.toHaveBeenCalled();
	});

	it('still skips during IME composition (modifier-Enter included)', () => {
		const onSend = vi.fn();
		const handler = composerEnterHandler('newline', onSend);
		const e = makeKeyEvent({ key: 'Enter', metaKey: true, isComposing: true });
		handler(e);
		expect(onSend).not.toHaveBeenCalled();
	});
});

describe('composerEnterHandler — handler identity', () => {
	it('returns a fresh function on each call (no shared closure state)', () => {
		const onSend = vi.fn();
		const a = composerEnterHandler('send', onSend);
		const b = composerEnterHandler('send', onSend);
		expect(a).not.toBe(b);
	});
});
