/* @vitest-environment happy-dom */

/**
 * Component test for the security settings page. The page renders a
 * list of passkeys with rename/delete affordances, an "Add passkey"
 * form, and uses the app-wide ConfirmDialog for delete confirmation.
 * The WebAuthn ceremony itself is the browser's responsibility — we
 * assert the page wires up the right HTTP calls around it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { PasskeySummary } from '$lib/server/db/queries/passkey';

const invalidateMock = vi.fn();
vi.mock('$app/navigation', () => ({
	invalidate: (key: string) => invalidateMock(key),
	goto: vi.fn(),
}));

// The page dynamic-imports @simplewebauthn/browser inside addPasskey().
// We never actually trigger that path in these tests (the "Add" tests
// don't await the network round-trip), so a stub is unnecessary — but
// declaring the mock keeps Vitest from trying to resolve the package
// during the dynamic import attempts in unrelated assertions.
vi.mock('@simplewebauthn/browser', () => ({
	startRegistration: vi.fn(),
	startAuthentication: vi.fn(),
}));

import SecurityPage from '../../src/routes/(app)/settings/security/+page.svelte';
import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
import { confirmDialog } from '$lib/confirm.svelte';

const fetchMock = vi.fn();

// Default baseData has the operator already linked to GitHub. This is
// the post-/setup-via-GitHub shape — passkey-delete + provider-unlink
// affordances are visible because the user has another method to fall
// back on. Tests that exercise the last-method guards override this.
const baseData = {
	githubEnabled: true,
	passkeyEnabled: true,
	oauthAccounts: [
		{
			provider: 'github',
			externalId: '42',
			externalUsername: 'octocat',
			externalEmail: null,
			createdAt: Date.now(),
		},
	] as Array<{
		provider: string;
		externalId: string;
		externalUsername: string | null;
		externalEmail: string | null;
		createdAt: number;
	}>,
};

beforeEach(() => {
	invalidateMock.mockReset();
	fetchMock.mockReset();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	if (confirmDialog.pending) confirmDialog.cancel();
});

function mkPasskey(over: Partial<PasskeySummary> = {}): PasskeySummary {
	return {
		id: over.id ?? 'cred-1',
		name: over.name ?? null,
		backedUp: over.backedUp ?? true,
		deviceType: over.deviceType ?? 'multiDevice',
		createdAt: over.createdAt ?? Date.now(),
		lastUsedAt: over.lastUsedAt ?? null,
	};
}

describe('Security settings page — empty state', () => {
	it('shows the empty-state copy when no passkeys are registered', () => {
		render(SecurityPage, { props: { data: { ...baseData, passkeys: [] } } });
		expect(screen.getByText(/No passkeys yet/)).toBeInTheDocument();
	});

	it('renders the linked OAuth account read-only when one is bound', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					passkeys: [],
					oauthAccounts: [
						{
							provider: 'github',
							externalId: '42',
							externalUsername: 'octocat',
							externalEmail: null,
							createdAt: Date.now(),
						},
					],
				},
			},
		});
		expect(screen.getByText('GitHub')).toBeInTheDocument();
		expect(screen.getByText('@octocat')).toBeInTheDocument();
	});

	it('shows the "no OAuth accounts" empty state when none are bound', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, oauthAccounts: [], passkeys: [] } },
		});
		expect(screen.getByText(/No OAuth accounts linked/)).toBeInTheDocument();
	});

	it('exposes the "Add passkey" button when passkey login is enabled', () => {
		render(SecurityPage, { props: { data: { ...baseData, passkeys: [] } } });
		expect(screen.getByRole('button', { name: /Add passkey/ })).toBeInTheDocument();
	});

	it('hides the "Add passkey" button when passkey login is disabled', () => {
		render(SecurityPage, {
			props: {
				data: { ...baseData, passkeyEnabled: false, passkeys: [] },
			},
		});
		expect(screen.queryByRole('button', { name: /Add passkey/ })).toBeNull();
	});
});

describe('Security settings page — list rendering', () => {
	it('renders a row per passkey with its name', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					passkeys: [
						mkPasskey({ id: 'a', name: 'iPhone' }),
						mkPasskey({ id: 'b', name: '1Password' }),
					],
				},
			},
		});
		expect(screen.getByText('iPhone')).toBeInTheDocument();
		expect(screen.getByText('1Password')).toBeInTheDocument();
	});

	it('falls back to "Passkey · added <date>" when name is null', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'a', name: null })] } },
		});
		expect(screen.getByText(/Passkey · added /)).toBeInTheDocument();
	});

	it('shows "never" for last-used until the credential is used', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'a', lastUsedAt: null })] } },
		});
		expect(screen.getByText(/Last used\s+never/)).toBeInTheDocument();
	});

	it('renders a "Synced" badge when the credential is backed up', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'a', backedUp: true })] } },
		});
		expect(screen.getByText('Synced')).toBeInTheDocument();
	});

	it('omits the "Synced" badge for single-device credentials', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					passkeys: [mkPasskey({ id: 'a', backedUp: false, deviceType: 'singleDevice' })],
				},
			},
		});
		expect(screen.queryByText('Synced')).toBeNull();
	});
});

describe('Security settings page — delete flow', () => {
	it('opens ConfirmDialog with the passkey name when delete is clicked', async () => {
		const user = userEvent.setup();
		render(SecurityPage, {
			props: {
				data: { ...baseData, passkeys: [mkPasskey({ id: 'cred-1', name: 'iPhone' })] },
			},
		});
		render(ConfirmDialog);

		await user.click(screen.getByLabelText('Delete passkey'));
		await tick();

		const dialog = screen.getByRole('alertdialog');
		expect(within(dialog).getByText('Delete this passkey?')).toBeInTheDocument();
		expect(within(dialog).getByText(/iPhone/)).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
	});

	it('DELETEs the passkey and invalidates settings:passkeys on confirm', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'cred-1' })] } },
		});
		render(ConfirmDialog);

		await user.click(screen.getByLabelText('Delete passkey'));
		await tick();
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/auth/passkey/cred-1');
		expect((init as RequestInit | undefined)?.method).toBe('DELETE');
		expect(invalidateMock).toHaveBeenCalledWith('settings:passkeys');
	});

	it('does not call fetch when the user cancels the delete', async () => {
		const user = userEvent.setup();
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'cred-1' })] } },
		});
		render(ConfirmDialog);

		await user.click(screen.getByLabelText('Delete passkey'));
		await tick();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(invalidateMock).not.toHaveBeenCalled();
	});

	it('hides the delete button on the sole remaining passkey when no OAuth provider is linked', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					oauthAccounts: [],
					passkeys: [mkPasskey({ id: 'only' })],
				},
			},
		});
		expect(screen.queryByLabelText('Delete passkey')).toBeNull();
	});

	it('keeps the delete button visible on the sole remaining passkey when an OAuth provider is linked', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					passkeys: [mkPasskey({ id: 'only' })],
				},
			},
		});
		expect(screen.getByLabelText('Delete passkey')).toBeInTheDocument();
	});
});

describe('Security settings page — OAuth unlink', () => {
	it('renders an unlink button on each provider row when another method exists', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'p1' })] } },
		});
		expect(screen.getByLabelText('Unlink provider')).toBeInTheDocument();
	});

	it('hides the unlink button when it would leave no viable sign-in method', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [] } },
		});
		expect(screen.queryByLabelText('Unlink provider')).toBeNull();
	});

	it('DELETEs the provider and invalidates on confirm', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'p1' })] } },
		});
		render(ConfirmDialog);

		await user.click(screen.getByLabelText('Unlink provider'));
		await tick();
		await user.click(screen.getByRole('button', { name: 'Unlink' }));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/auth/oauth/github');
		expect((init as RequestInit | undefined)?.method).toBe('DELETE');
		expect(invalidateMock).toHaveBeenCalledWith('settings:oauth-accounts');
	});
});

describe('Security settings page — Link GitHub', () => {
	it('renders the Link GitHub button when GitHub is enabled and not linked', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, oauthAccounts: [], passkeys: [mkPasskey({ id: 'p' })] } },
		});
		expect(screen.getByRole('button', { name: /Link GitHub/ })).toBeInTheDocument();
	});

	it('hides the Link GitHub button when already linked', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'p' })] } },
		});
		expect(screen.queryByRole('button', { name: /Link GitHub/ })).toBeNull();
	});

	it('hides the Link GitHub button when GITHUB_LOGIN_ENABLED is false', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					githubEnabled: false,
					oauthAccounts: [],
					passkeys: [mkPasskey({ id: 'p' })],
				},
			},
		});
		expect(screen.queryByRole('button', { name: /Link GitHub/ })).toBeNull();
	});
});

describe('Security settings page — rename flow', () => {
	it('PATCHes the new name on Enter and invalidates the load', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ ok: true, name: 'iPhone' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'cred-1', name: null })] } },
		});

		await user.click(screen.getByLabelText('Rename passkey'));
		const input = screen.getByLabelText('Passkey name');
		await user.type(input, 'iPhone{Enter}');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/auth/passkey/cred-1');
		expect((init as RequestInit | undefined)?.method).toBe('PATCH');
		const body = JSON.parse(((init as RequestInit).body as string) ?? '{}');
		expect(body).toEqual({ name: 'iPhone' });
		expect(invalidateMock).toHaveBeenCalledWith('settings:passkeys');
	});

	it('cancels the rename on Escape without calling fetch', async () => {
		const user = userEvent.setup();
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'cred-1', name: 'orig' })] } },
		});

		await user.click(screen.getByLabelText('Rename passkey'));
		const input = screen.getByLabelText('Passkey name');
		await user.type(input, 'changed{Escape}');

		expect(fetchMock).not.toHaveBeenCalled();
		// And the input is gone, leaving the original name visible.
		expect(screen.queryByLabelText('Passkey name')).toBeNull();
		expect(screen.getByText('orig')).toBeInTheDocument();
	});
});
