/**
 * The avatar beside a reply hides itself when its image fails. Server
 * rendering turns an element's error handler into an inline `onerror`
 * attribute, which the CSP blocks (it logged a violation on every chat with an
 * avatar) — so the handler is attached on the client instead, and the server
 * HTML must carry no inline handler at all.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import AssistantAvatar from '#lib/components/chat/AssistantAvatar.svelte';

describe('AssistantAvatar on the server', () => {
	it('renders no inline event handler for the CSP to block', () => {
		const { body } = render(AssistantAvatar, { props: { mediaId: 'm1', label: 'Fox' } });
		expect(body).toContain('/api/media/m1/thumbnail');
		expect(body).not.toMatch(/\son[a-z]+=/i);
	});
});
