/**
 * /settings/mcp's "Always allow" switches show what the server stored: a
 * failed grant or revoke leaves the switch where it was, and a click made
 * while another tool's request is in flight can't flip one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';

vi.mock('$app/navigation', () => ({
	invalidate: vi.fn(async () => {}),
	refreshAll: vi.fn(async () => {}),
	goto: vi.fn(async () => {}),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
}));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, base: '', assets: '' }));

import McpPage from '../../src/routes/(app)/settings/mcp/+page.svelte';

const settle = () => new Promise((r) => setTimeout(r, 20));
afterEach(() => vi.unstubAllGlobals());

const tool = (name: string, trusted: boolean) => ({
	name,
	registeredName: `mcp__files__${name}`,
	description: '',
	trusted,
});
function pageData(tools: Array<ReturnType<typeof tool>>) {
	return {
		isAdmin: false,
		servers: [
			{
				id: 'files',
				displayName: 'Files',
				transport: 'http' as const,
				auth: 'global' as const,
				perUser: false,
				configured: true,
				state: 'connected' as const,
				error: null,
				tools,
			},
		],
	};
}

describe('/settings/mcp — Always allow', () => {
	it.each([
		['the server answers 500', () => Promise.resolve(new Response('{}', { status: 500 }))],
		['the request never arrives', () => Promise.reject(new TypeError('Failed to fetch'))],
	])('keeps a tool shown as trusted when revoking fails: %s', async (_n, respond) => {
		const methods: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_u: string, init?: RequestInit) => {
				methods.push(init?.method ?? 'GET');
				return respond();
			}),
		);
		const user = userEvent.setup();
		render(McpPage, { props: { data: pageData([tool('write', true)]) } });
		const sw = screen.getByRole('switch', { name: 'Always allow write' });
		expect(sw).toHaveAttribute('data-state', 'checked');

		await user.click(sw);
		await settle();

		expect(methods).toEqual(['DELETE']);
		expect(sw).toHaveAttribute('data-state', 'checked');
	});

	it('puts the switch back when granting fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))),
		);
		const user = userEvent.setup();
		render(McpPage, { props: { data: pageData([tool('read', false)]) } });
		const sw = screen.getByRole('switch', { name: 'Always allow read' });

		await user.click(sw);
		await settle();

		expect(sw).toHaveAttribute('data-state', 'unchecked');
	});

	it("doesn't flip another tool's switch while a request is in flight", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const urls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (u: string) => {
				urls.push(u);
				await gate;
				return new Response('{}', { status: 200 });
			}),
		);
		const two = (readTrusted: boolean) =>
			pageData([tool('read', readTrusted), tool('write', true)]);
		const user = userEvent.setup();
		const view = render(McpPage, { props: { data: two(false) } });
		await user.click(screen.getByRole('switch', { name: 'Always allow read' }));
		const write = screen.getByRole('switch', { name: 'Always allow write' });
		await user.click(write);
		expect(urls).toHaveLength(1);
		expect(write).toHaveAttribute('data-state', 'checked');

		release();
		await settle();
		// What invalidate('settings:mcp') delivers: read now trusted, write untouched.
		await view.rerender({ data: two(true) });
		await settle();

		expect(write).toHaveAttribute('data-state', 'checked');
	});
});
