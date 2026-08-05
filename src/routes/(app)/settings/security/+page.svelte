<script lang="ts">
	import SettingsPage from '$lib/components/settings/SettingsPage.svelte';
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { Check, KeyRound, Laptop, Pencil, Plus, Trash2, X } from '@lucide/svelte';
	import ProviderIcon from '$lib/components/ProviderIcon.svelte';
	import type { OAuthAccountSummary } from '$lib/server/db/queries/oauth-accounts';
	import type { PasskeySummary } from '$lib/server/db/queries/passkey';
	import type { SessionSummary } from '$lib/server/auth/session';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { toast } from '$lib/toast.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';

	interface ProviderInfo {
		id: string;
		label: string;
		enabled: boolean;
	}

	let { data } = $props<{
		data: {
			passkeys: PasskeySummary[];
			oauthAccounts: OAuthAccountSummary[];
			providers: ProviderInfo[];
			passkeyEnabled: boolean;
			sessions: SessionSummary[];
			currentSessionId: string | null;
		};
	}>();

	let sessionBusyId = $state<string | null>(null);
	let revokeAllBusy = $state(false);

	let linkBusy = $state(false);

	// Surface the link-flow result from the callback's ?link= redirect.
	$effect(() => {
		const result = page.url.searchParams.get('link');
		if (!result) return;
		if (result === 'success') toast.success('Provider linked.');
		else if (result === 'already_linked') toast.error('That provider is already linked.');
		else if (result === 'invalid_state') toast.error('Link attempt failed (state mismatch).');
		else if (result === 'exchange_failed') toast.error('Could not complete sign-in.');
		else if (result === 'upstream_failure') toast.error('The provider is unreachable right now.');
		else toast.error(`Link failed (${result}).`);
		// Strip the query so a reload doesn't replay the toast.
		const next = new URL(page.url);
		next.searchParams.delete('link');
		window.history.replaceState({}, '', next.toString());
	});

	const linkedProviders = $derived(
		new Set(data.oauthAccounts.map((a: OAuthAccountSummary) => a.provider)),
	);

	// Enabled providers the user hasn't bound yet — the "Link …" buttons.
	const linkableProviders = $derived(
		data.providers.filter((p: ProviderInfo) => p.enabled && !linkedProviders.has(p.id)),
	);

	function providerLabel(provider: string): string {
		// Friendly name from the registry; falls back to the raw id for a
		// provider that was bound and later disabled/removed from config.
		return data.providers.find((p: ProviderInfo) => p.id === provider)?.label ?? provider;
	}

	// A binding whose provider the admin has since turned off (or dropped
	// from the registry) still exists but can no longer be signed in with.
	// That's the one piece of provider state the user can't infer from what
	// this page offers them, so the row says it.
	function providerDisabled(provider: string): boolean {
		return !data.providers.find((p: ProviderInfo) => p.id === provider)?.enabled;
	}

	let addBusy = $state(false);
	let addName = $state('');
	let addError = $state<string | null>(null);

	let busyId = $state<string | null>(null);
	let renamingId = $state<string | null>(null);
	let renameDraft = $state('');

	function formatDate(ms: number): string {
		const d = new Date(ms);
		const now = new Date();
		const sameYear = d.getFullYear() === now.getFullYear();
		return d.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: sameYear ? undefined : 'numeric',
		});
	}

	function displayName(p: PasskeySummary): string {
		return p.name ?? `Passkey · added ${formatDate(p.createdAt)}`;
	}

	/** Coarse "last active" — the point is spotting a session you don't
	 *  recognize, which needs recency, not a timestamp. */
	function formatLastSeen(ms: number): string {
		if (!ms) return 'unknown';
		const mins = Math.floor((Date.now() - ms) / 60_000);
		if (mins < 5) return 'just now';
		if (mins < 60) return `${mins} min ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
		return formatDate(ms);
	}

	/**
	 * A short device label from the User-Agent. Deliberately crude: the UA is
	 * an unvalidated client string, so it's matched against a fixed list and
	 * never rendered raw — a hostile UA can at worst pick which of these
	 * labels it gets.
	 */
	function deviceLabel(ua: string | null): string {
		if (!ua) return 'Unknown device';
		const os = /iPhone|iPad/.test(ua)
			? 'iOS'
			: /Android/.test(ua)
				? 'Android'
				: /Mac OS X/.test(ua)
					? 'macOS'
					: /Windows/.test(ua)
						? 'Windows'
						: /Linux/.test(ua)
							? 'Linux'
							: null;
		// Order matters: Edge and Chrome both claim "Chrome", Safari claims
		// none of the others.
		const browser = /Edg\//.test(ua)
			? 'Edge'
			: /Firefox\//.test(ua)
				? 'Firefox'
				: /Chrome\//.test(ua)
					? 'Chrome'
					: /Safari\//.test(ua)
						? 'Safari'
						: null;
		if (os && browser) return `${browser} on ${os}`;
		return browser ?? os ?? 'Unknown device';
	}

	async function revokeSession(s: SessionSummary) {
		if (sessionBusyId) return;
		const self = s.id === data.currentSessionId;
		const ok = await confirmDialog.ask({
			title: self ? 'Sign out this device?' : 'Sign out that device?',
			message: self
				? "This is the device you're using now — you'll be returned to the sign-in page."
				: `"${deviceLabel(s.userAgent)}" will be signed out immediately.`,
			confirmLabel: 'Sign out',
		});
		if (!ok) return;
		sessionBusyId = s.id;
		try {
			const res = await fetch(`/api/auth/sessions/${encodeURIComponent(s.id)}`, {
				method: 'DELETE',
			});
			if (!res.ok && res.status !== 404) {
				toast.error(`Couldn't sign out: ${await errorMessageFromResponse(res)}`);
				return;
			}
			if (self) {
				window.location.href = '/login';
				return;
			}
			toast.success('Device signed out.');
			await invalidate('settings:sessions');
		} finally {
			sessionBusyId = null;
		}
	}

	async function revokeOtherSessions() {
		if (revokeAllBusy) return;
		const ok = await confirmDialog.ask({
			title: 'Sign out everywhere else?',
			message:
				'Every other device will be signed out immediately. This one stays signed in. Use this if you think someone else has access.',
			confirmLabel: 'Sign out others',
		});
		if (!ok) return;
		revokeAllBusy = true;
		try {
			const res = await fetch('/api/auth/sessions', { method: 'DELETE' });
			if (!res.ok) {
				toast.error(`Couldn't sign out: ${await errorMessageFromResponse(res)}`);
				return;
			}
			const { revoked } = (await res.json()) as { revoked: number };
			toast.success(
				revoked === 0
					? 'No other devices were signed in.'
					: `Signed out ${revoked} other device${revoked === 1 ? '' : 's'}.`,
			);
			await invalidate('settings:sessions');
		} finally {
			revokeAllBusy = false;
		}
	}

	// A user is locked into a single remaining passkey when no OAuth
	// binding exists AND this is their only credential. The server
	// enforces this too (409 from DELETE); hiding the trash icon
	// avoids surfacing a button that's guaranteed to error.
	const lastMethodLocked = $derived(data.oauthAccounts.length === 0 && data.passkeys.length <= 1);

	// Same shape applies to OAuth bindings: refuse the unlink if it
	// would leave the user with zero passkeys AND zero remaining
	// bindings.
	function canUnlinkOAuth(): boolean {
		return data.oauthAccounts.length - 1 + data.passkeys.length > 0;
	}

	async function unlinkProvider(provider: string) {
		if (linkBusy) return;
		const label = providerLabel(provider);
		const ok = await confirmDialog.ask({
			title: `Unlink ${label}?`,
			message: `You won't be able to sign in via ${label} after this.`,
			confirmLabel: 'Unlink',
		});
		if (!ok) return;
		linkBusy = true;
		try {
			const res = await fetch(`/api/auth/oauth/${encodeURIComponent(provider)}`, {
				method: 'DELETE',
			});
			if (!res.ok) {
				toast.error(`Couldn't unlink: ${await errorMessageFromResponse(res)}`);
				return;
			}
			toast.success(`${label} unlinked.`);
			await invalidate('settings:oauth-accounts');
		} finally {
			linkBusy = false;
		}
	}

	// The link-start endpoints are plain GET navigations (anchor hrefs):
	// POST-via-form would trip the CSP's `form-action 'self'` since the
	// endpoint ultimately redirects to the external IdP; top-level
	// navigations aren't policed the same way.

	async function addPasskey() {
		if (addBusy) return;
		addBusy = true;
		addError = null;
		try {
			const { startRegistration } = await import('@simplewebauthn/browser');

			const optionsRes = await fetch('/api/auth/passkey/register/options', { method: 'POST' });
			if (!optionsRes.ok) {
				addError = await errorMessageFromResponse(optionsRes);
				return;
			}
			const optionsJSON = await optionsRes.json();

			let regResponse;
			try {
				regResponse = await startRegistration({ optionsJSON });
			} catch (e) {
				if (e instanceof DOMException && e.name === 'NotAllowedError') return;
				addError = e instanceof Error ? e.message : String(e);
				return;
			}

			const trimmedName = addName.trim();
			const verifyRes = await fetch('/api/auth/passkey/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					response: regResponse,
					name: trimmedName.length > 0 ? trimmedName : null,
				}),
			});
			if (!verifyRes.ok) {
				addError = await errorMessageFromResponse(verifyRes);
				return;
			}
			addName = '';
			toast.success('Passkey added.');
			await invalidate('settings:passkeys');
		} finally {
			addBusy = false;
		}
	}

	async function deletePasskey(p: PasskeySummary) {
		if (busyId) return;
		const ok = await confirmDialog.ask({
			title: 'Delete this passkey?',
			message: `You won't be able to sign in with "${displayName(p)}" after this.`,
			confirmLabel: 'Delete',
		});
		if (!ok) return;
		busyId = p.id;
		try {
			const res = await fetch(`/api/auth/passkey/${encodeURIComponent(p.id)}`, {
				method: 'DELETE',
			});
			if (!res.ok && res.status !== 404) {
				toast.error(`Couldn't delete: ${await errorMessageFromResponse(res)}`);
				return;
			}
			toast.success('Passkey removed.');
			await invalidate('settings:passkeys');
		} finally {
			busyId = null;
		}
	}

	function startRename(p: PasskeySummary) {
		renamingId = p.id;
		renameDraft = p.name ?? '';
	}

	function cancelRename() {
		renamingId = null;
		renameDraft = '';
	}

	async function commitRename(p: PasskeySummary) {
		const trimmed = renameDraft.trim();
		const next = trimmed.length > 0 ? trimmed : null;
		if (next === p.name) {
			cancelRename();
			return;
		}
		busyId = p.id;
		try {
			const res = await fetch(`/api/auth/passkey/${encodeURIComponent(p.id)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: next }),
			});
			if (!res.ok) {
				toast.error(`Couldn't rename: ${await errorMessageFromResponse(res)}`);
				return;
			}
			renamingId = null;
			renameDraft = '';
			await invalidate('settings:passkeys');
		} finally {
			busyId = null;
		}
	}

	function onRenameKeydown(event: KeyboardEvent, p: PasskeySummary) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void commitRename(p);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cancelRename();
		}
	}
</script>

<SettingsPage title="Security">
	{#snippet description()}
		Manage how you sign in to this instance.
	{/snippet}

	<div class="mx-auto flex max-w-2xl flex-col gap-4">
		<section class="panel-card p-4">
			<h2 class="text-sm font-semibold">Linked accounts</h2>
			<p class="mt-1 text-xs text-fg-muted">
				OAuth providers bound to this account. Each binding is an independent sign-in method.
			</p>
			{#if data.oauthAccounts.length === 0}
				<p class="mt-4 py-6 text-center text-sm text-fg-muted">
					No OAuth accounts linked. You sign in via passkey only.
				</p>
			{:else}
				<ul class="mt-3 flex flex-col gap-2">
					{#each data.oauthAccounts as a (a.provider + ':' + a.externalId)}
						<li
							class="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-surface-raised/40 px-3 py-2.5 text-sm"
						>
							<div class="flex min-w-0 flex-1 items-center gap-2.5">
								<ProviderIcon provider={a.provider} size={18} />
								<div class="min-w-0">
									<div class="flex items-center gap-2 font-medium">
										<span class="truncate">{providerLabel(a.provider)}</span>
										{#if providerDisabled(a.provider)}
											<span
												class="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-fg-muted"
												title="An admin has turned this provider off — the binding stays, but you can't sign in with it."
												>Sign-in off</span
											>
										{/if}
									</div>
									<div class="text-xs text-fg-muted">
										{a.externalUsername ? `@${a.externalUsername}` : `id ${a.externalId}`}
									</div>
								</div>
							</div>
							{#if canUnlinkOAuth()}
								<button
									type="button"
									onclick={() => unlinkProvider(a.provider)}
									disabled={linkBusy}
									aria-label="Unlink provider"
									class="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-sunken hover:text-danger disabled:opacity-50"
								>
									<Trash2 size={14} strokeWidth={2.25} />
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if linkableProviders.length > 0}
				<div class="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
					{#each linkableProviders as provider (provider.id)}
						<a
							href="/api/auth/oauth/{provider.id}/link/start"
							class="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm font-medium text-fg transition hover:bg-surface-sunken"
						>
							<Plus size={14} strokeWidth={2.25} />
							Link {provider.label}
						</a>
					{/each}
				</div>
			{/if}
		</section>

		{#if data.passkeyEnabled || data.passkeys.length > 0}
			<section class="panel-card p-4">
				<div class="flex items-baseline justify-between">
					<h2 class="text-sm font-semibold">Passkeys</h2>
					<span class="text-xs text-fg-muted">{data.passkeys.length} registered</span>
				</div>
				{#if !data.passkeyEnabled}
					<p class="mt-1 text-xs text-fg-muted">
						An admin has turned passkey sign-in off. These stay registered but can't be used to sign
						in — remove any you no longer want on file.
					</p>
				{/if}

				{#if data.passkeys.length === 0}
					<p class="mt-4 py-6 text-center text-sm text-fg-muted">
						No passkeys yet. Add one to sign in without an OAuth provider.
					</p>
				{:else}
					<ul class="mt-3 flex flex-col gap-2">
						{#each data.passkeys as p (p.id)}
							<li
								class="flex items-start gap-3 rounded-md border border-border/60 bg-surface-raised/40 px-3 py-2.5"
							>
								<KeyRound size={16} strokeWidth={2.25} class="mt-0.5 shrink-0 text-fg-muted" />
								<div class="min-w-0 flex-1">
									{#if renamingId === p.id}
										<div class="flex items-center gap-2">
											<input
												type="text"
												bind:value={renameDraft}
												maxlength="60"
												placeholder="Passkey name"
												aria-label="Passkey name"
												onkeydown={(e) => onRenameKeydown(e, p)}
												class="min-w-0 flex-1 rounded border border-border bg-surface-panel px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-fg"
											/>
											<button
												type="button"
												onclick={() => commitRename(p)}
												aria-label="Save name"
												class="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-sunken hover:text-fg"
											>
												<Check size={14} strokeWidth={2.25} />
											</button>
											<button
												type="button"
												onclick={cancelRename}
												aria-label="Cancel rename"
												class="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-sunken hover:text-fg"
											>
												<X size={14} strokeWidth={2.25} />
											</button>
										</div>
									{:else}
										<div class="flex items-center gap-2 text-sm font-medium">
											<span class="truncate">{displayName(p)}</span>
											{#if p.backedUp}
												<span
													class="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-fg-muted"
													>Synced</span
												>
											{/if}
											<span
												class="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-fg-muted"
											>
												{p.deviceType === 'multiDevice' ? 'Cross-device' : 'This device'}
											</span>
										</div>
										<div class="mt-1 text-xs text-fg-muted">
											Added {formatDate(p.createdAt)} · Last used
											{p.lastUsedAt ? formatDate(p.lastUsedAt) : 'never'}
										</div>
									{/if}
								</div>
								{#if renamingId !== p.id}
									<div class="flex shrink-0 items-center gap-1">
										<button
											type="button"
											onclick={() => startRename(p)}
											disabled={busyId === p.id}
											aria-label="Rename passkey"
											class="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-sunken hover:text-fg disabled:opacity-50"
										>
											<Pencil size={14} strokeWidth={2.25} />
										</button>
										{#if !(lastMethodLocked && data.passkeys.length === 1)}
											<button
												type="button"
												onclick={() => deletePasskey(p)}
												disabled={busyId === p.id}
												aria-label="Delete passkey"
												class="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-sunken hover:text-danger disabled:opacity-50"
											>
												<Trash2 size={14} strokeWidth={2.25} />
											</button>
										{/if}
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#if data.passkeyEnabled}
					<div class="mt-4 border-t border-border pt-4">
						<label class="block text-xs font-medium text-fg-muted" for="passkey-name">
							Name (optional)
						</label>
						<div class="mt-1 flex gap-2">
							<input
								id="passkey-name"
								type="text"
								bind:value={addName}
								maxlength="60"
								placeholder="e.g. iPhone, 1Password"
								class="min-w-0 flex-1 rounded border border-border bg-surface-panel px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-fg"
							/>
							<button
								type="button"
								onclick={addPasskey}
								disabled={addBusy}
								class="inline-flex items-center gap-2 rounded-lg bg-surface-inverse px-4 py-1.5 text-sm font-medium text-fg-inverse transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
							>
								<KeyRound size={14} strokeWidth={2.25} />
								{addBusy ? 'Waiting…' : 'Add passkey'}
							</button>
						</div>
						{#if addError}
							<p class="mt-2 rounded-lg border px-2 py-1.5 text-xs alert-danger">
								{addError}
							</p>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		<section class="panel-card p-4">
			<div class="flex items-baseline justify-between">
				<h2 class="text-sm font-semibold">Signed-in devices</h2>
				<span class="text-xs text-fg-muted">{data.sessions.length} active</span>
			</div>
			<p class="mt-1 text-xs text-fg-muted">
				Every device currently signed in to your account. Sign one out if you don't recognize it.
				Sessions expire after up to 30 days of inactivity, and always within 90 days of signing in.
			</p>

			<ul class="mt-3 flex flex-col gap-2">
				{#each data.sessions as s (s.id)}
					<li
						class="flex items-start gap-3 rounded-md border border-border/60 bg-surface-raised/40 px-3 py-2.5"
					>
						<Laptop size={16} strokeWidth={2.25} class="mt-0.5 shrink-0 text-fg-muted" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 text-sm font-medium">
								<span class="truncate">{deviceLabel(s.userAgent)}</span>
								{#if s.id === data.currentSessionId}
									<span
										class="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-fg-muted"
										>This device</span
									>
								{/if}
							</div>
							<div class="mt-1 text-xs text-fg-muted">
								Signed in {formatDate(s.createdAt)} · Last active {formatLastSeen(s.lastSeenAt)}
							</div>
						</div>
						<button
							type="button"
							onclick={() => revokeSession(s)}
							disabled={sessionBusyId === s.id}
							aria-label="Sign out this device"
							class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-surface-sunken hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
						>
							<Trash2 size={14} strokeWidth={2.25} />
						</button>
					</li>
				{/each}
			</ul>

			{#if data.sessions.length > 1}
				<div class="mt-3 border-t border-border/60 pt-3">
					<button
						type="button"
						onclick={revokeOtherSessions}
						disabled={revokeAllBusy}
						class="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
					>
						{revokeAllBusy ? 'Signing out…' : 'Sign out everywhere else'}
					</button>
				</div>
			{/if}
		</section>
	</div>
</SettingsPage>
