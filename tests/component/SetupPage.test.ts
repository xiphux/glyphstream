/* @vitest-environment happy-dom */

/**
 * Component test for the /setup wizard. Exercises the gated state,
 * both buttons rendering based on the methods toggles, and the
 * inline display-name validation on the passkey path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';

vi.mock('@simplewebauthn/browser', () => ({
	startRegistration: vi.fn(),
	startAuthentication: vi.fn(),
}));

import SetupPage from '../../src/routes/(auth)/setup/+page.svelte';

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

const baseData = {
	gated: false,
	token: '',
	errorMessage: null as string | null,
	methods: {
		providers: [{ id: 'github', label: 'GitHub' }] as Array<{ id: string; label: string }>,
		passkey: true,
	},
};

describe('SetupPage — happy path', () => {
	it('renders display name + email inputs and both buttons', () => {
		render(SetupPage, { props: { data: baseData } });
		expect(screen.getByLabelText('Display name')).toBeInTheDocument();
		expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Set up a passkey/ })).toBeInTheDocument();
	});

	it('renders a button per enabled provider', () => {
		render(SetupPage, {
			props: {
				data: {
					...baseData,
					methods: {
						providers: [
							{ id: 'github', label: 'GitHub' },
							{ id: 'google', label: 'Google' },
							{ id: 'oidc', label: 'Company SSO' },
						],
						passkey: true,
					},
				},
			},
		});
		expect(screen.getByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Continue with Company SSO/ })).toBeInTheDocument();
	});

	it('hides all provider buttons when no providers are enabled', () => {
		render(SetupPage, {
			props: { data: { ...baseData, methods: { providers: [], passkey: true } } },
		});
		expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull();
		expect(screen.getByRole('button', { name: /Set up a passkey/ })).toBeInTheDocument();
	});

	it('hides the passkey button when passkey is disabled', () => {
		render(SetupPage, {
			props: {
				data: {
					...baseData,
					methods: { providers: [{ id: 'github', label: 'GitHub' }], passkey: false },
				},
			},
		});
		expect(screen.queryByRole('button', { name: /Set up a passkey/ })).toBeNull();
		expect(screen.getByRole('button', { name: /Continue with GitHub/ })).toBeInTheDocument();
	});
});

describe('SetupPage — gated', () => {
	it('shows the gated message and no buttons when gated is true', () => {
		render(SetupPage, { props: { data: { ...baseData, gated: true } } });
		expect(screen.getByText(/setup token/i)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Continue with GitHub/ })).toBeNull();
		expect(screen.queryByRole('button', { name: /Set up a passkey/ })).toBeNull();
	});
});

describe('SetupPage — surfaced errors', () => {
	it('renders the load-supplied errorMessage in the alert region', () => {
		render(SetupPage, {
			props: { data: { ...baseData, errorMessage: 'Setup attempt failed' } },
		});
		expect(screen.getByText('Setup attempt failed')).toBeInTheDocument();
	});
});

describe('SetupPage — passkey validation', () => {
	it('refuses the passkey path when the display name is empty', async () => {
		const user = userEvent.setup();
		render(SetupPage, { props: { data: baseData } });
		await user.click(screen.getByRole('button', { name: /Set up a passkey/ }));
		expect(screen.getByText(/Pick a display name first/)).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('starts the passkey ceremony when a display name is supplied', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ challenge: 'c' })));
		render(SetupPage, { props: { data: baseData } });
		await user.type(screen.getByLabelText('Display name'), 'Operator');
		await user.click(screen.getByRole('button', { name: /Set up a passkey/ }));
		// First fetch is the /options POST. The startRegistration mock
		// returns undefined → ceremony errors out, but the body shape
		// alone is what we're asserting.
		expect(fetchMock).toHaveBeenCalled();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/auth/setup/passkey/options');
		const body = JSON.parse(((init as RequestInit).body as string) ?? '{}');
		expect(body).toEqual({ displayName: 'Operator', email: '' });
	});

	it('appends the setup token to the URL when one is supplied', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ challenge: 'c' })));
		render(SetupPage, { props: { data: { ...baseData, token: 'secret' } } });
		await user.type(screen.getByLabelText('Display name'), 'Operator');
		await user.click(screen.getByRole('button', { name: /Set up a passkey/ }));
		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/auth/setup/passkey/options?token=secret');
	});
});
