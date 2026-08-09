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
	providers: [{ id: 'github', label: 'GitHub', enabled: true }] as Array<{
		id: string;
		label: string;
		enabled: boolean;
	}>,
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
	sessions: [] as Array<{
		id: string;
		createdAt: number;
		lastSeenAt: number;
		expiresAt: number;
		userAgent: string | null;
	}>,
	currentSessionId: null as string | null,
};

const CHROME_MAC =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SAFARI_IOS =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function mkSession(over: Partial<(typeof baseData.sessions)[number]> = {}) {
	return {
		id: 's1',
		createdAt: Date.now() - 86_400_000,
		lastSeenAt: Date.now() - 60_000,
		expiresAt: Date.now() + 86_400_000,
		userAgent: CHROME_MAC,
		...over,
	};
}

beforeEach(() => {
	invalidateMock.mockReset();
	fetchMock.mockReset();
	globalThis.fetch = fetchMock;
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

	// The page advertises methods by what it offers, not by a config
	// matrix: a disabled provider the user hasn't bound is something they
	// can't act on and an admin controls, so it renders nothing at all.
	it('says nothing about a disabled provider the user has not bound', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					providers: [
						{ id: 'github', label: 'GitHub', enabled: true },
						{ id: 'google', label: 'Google', enabled: false },
					],
					passkeys: [],
				},
			},
		});
		expect(screen.queryByText(/Google/)).toBeNull();
	});

	it('drops the Passkeys section entirely when passkey login is off and none exist', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeyEnabled: false, passkeys: [] } },
		});
		expect(screen.queryByRole('heading', { name: 'Passkeys' })).toBeNull();
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

	// The inverse of the "say nothing about disabled providers" rule: once
	// a binding exists, the admin turning that provider off is state the
	// user can't infer from anything else on the page, so the row says it.
	it('flags a bound provider whose sign-in an admin has since turned off', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					providers: [{ id: 'github', label: 'GitHub', enabled: false }],
					passkeys: [mkPasskey({ id: 'a' })],
				},
			},
		});
		expect(screen.getByText('Sign-in off')).toBeInTheDocument();
	});

	it('leaves an enabled provider unflagged', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'a' })] } },
		});
		expect(screen.queryByText('Sign-in off')).toBeNull();
	});

	it('keeps registered passkeys visible with a note when passkey login is off', () => {
		render(SecurityPage, {
			props: {
				data: { ...baseData, passkeyEnabled: false, passkeys: [mkPasskey({ id: 'a' })] },
			},
		});
		expect(screen.getByRole('heading', { name: 'Passkeys' })).toBeInTheDocument();
		expect(screen.getByText(/can't be used to sign\s+in/)).toBeInTheDocument();
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
	it('renders the Link GitHub link when GitHub is enabled and not linked', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, oauthAccounts: [], passkeys: [mkPasskey({ id: 'p' })] } },
		});
		// Plain anchor — `<form method="POST">` would be CSP-blocked
		// since the start endpoint redirects to github.com.
		const link = screen.getByRole('link', { name: /Link GitHub/ });
		expect(link).toBeInTheDocument();
		expect(link.getAttribute('href')).toBe('/api/auth/oauth/github/link/start');
	});

	it('hides the Link GitHub link when already linked', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [mkPasskey({ id: 'p' })] } },
		});
		expect(screen.queryByRole('link', { name: /Link GitHub/ })).toBeNull();
	});

	it('hides the Link GitHub link when GITHUB_LOGIN_ENABLED is false', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					providers: [{ id: 'github', label: 'GitHub', enabled: false }],
					oauthAccounts: [],
					passkeys: [mkPasskey({ id: 'p' })],
				},
			},
		});
		expect(screen.queryByRole('link', { name: /Link GitHub/ })).toBeNull();
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

describe('Security settings page — signed-in devices', () => {
	it('labels each session by device and marks the current one', () => {
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					passkeys: [],
					sessions: [mkSession(), mkSession({ id: 's2', userAgent: SAFARI_IOS })],
					currentSessionId: 's1',
				},
			},
		});
		expect(screen.getByText('Chrome on macOS')).toBeInTheDocument();
		expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
		// Exactly one row carries the "This device" marker.
		expect(screen.getAllByText('This device')).toHaveLength(1);
	});

	it('never renders the raw User-Agent', () => {
		// The UA is an unvalidated client string. It is matched against a
		// fixed label list, never echoed — a hostile UA can at most choose
		// which of those labels it gets.
		const hostile = '<img src=x onerror=alert(1)> Chrome/120.0';
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [], sessions: [mkSession({ userAgent: hostile })] } },
		});
		expect(document.body.textContent).not.toContain('onerror');
		expect(screen.getByText('Chrome')).toBeInTheDocument();
	});

	it('falls back to a placeholder when no User-Agent was recorded', () => {
		render(SecurityPage, {
			props: { data: { ...baseData, passkeys: [], sessions: [mkSession({ userAgent: null })] } },
		});
		expect(screen.getByText('Unknown device')).toBeInTheDocument();
	});

	it('DELETEs a single session and invalidates on confirm', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, self: false })));
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					passkeys: [],
					sessions: [mkSession(), mkSession({ id: 's2', userAgent: SAFARI_IOS })],
					currentSessionId: 's1',
				},
			},
		});
		render(ConfirmDialog);

		await user.click(screen.getAllByLabelText('Sign out this device')[1]);
		await tick();
		await user.click(screen.getByRole('button', { name: 'Sign out' }));

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/auth/sessions/s2');
		expect((init as RequestInit | undefined)?.method).toBe('DELETE');
		expect(invalidateMock).toHaveBeenCalledWith('settings:sessions');
	});

	it('offers "sign out everywhere else" only when another session exists', () => {
		const { unmount } = render(SecurityPage, {
			props: {
				data: { ...baseData, passkeys: [], sessions: [mkSession()], currentSessionId: 's1' },
			},
		});
		expect(screen.queryByRole('button', { name: /everywhere else/ })).toBeNull();
		unmount();

		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					passkeys: [],
					sessions: [mkSession(), mkSession({ id: 's2' })],
					currentSessionId: 's1',
				},
			},
		});
		expect(screen.getByRole('button', { name: /everywhere else/ })).toBeInTheDocument();
	});

	it('DELETEs the collection for "sign out everywhere else"', async () => {
		const user = userEvent.setup();
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ revoked: 3 })));
		render(SecurityPage, {
			props: {
				data: {
					...baseData,
					passkeys: [],
					sessions: [mkSession(), mkSession({ id: 's2' })],
					currentSessionId: 's1',
				},
			},
		});
		render(ConfirmDialog);

		await user.click(screen.getByRole('button', { name: /everywhere else/ }));
		await tick();
		await user.click(screen.getByRole('button', { name: 'Sign out others' }));

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/auth/sessions');
		expect((init as RequestInit | undefined)?.method).toBe('DELETE');
		expect(invalidateMock).toHaveBeenCalledWith('settings:sessions');
	});
});
