<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { Check, KeyRound, Pencil, Plus, Trash2, X } from '@lucide/svelte';
	import type { OAuthAccountSummary } from '$lib/server/db/queries/oauth-accounts';
	import type { PasskeySummary } from '$lib/server/db/queries/passkey';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { toast } from '$lib/toast.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';

	let { data } = $props<{
		data: {
			passkeys: PasskeySummary[];
			oauthAccounts: OAuthAccountSummary[];
			githubEnabled: boolean;
			passkeyEnabled: boolean;
		};
	}>();

	let linkBusy = $state(false);

	// Surface the link-flow result from the callback's ?link= redirect.
	$effect(() => {
		const result = page.url.searchParams.get('link');
		if (!result) return;
		if (result === 'success') toast.success('Provider linked.');
		else if (result === 'already_linked') toast.error('That provider is already linked.');
		else if (result === 'invalid_state') toast.error('Link attempt failed (state mismatch).');
		else if (result === 'exchange_failed') toast.error('Could not complete sign-in with GitHub.');
		else if (result === 'upstream_failure') toast.error('GitHub is unreachable right now.');
		else toast.error(`Link failed (${result}).`);
		// Strip the query so a reload doesn't replay the toast.
		const next = new URL(page.url);
		next.searchParams.delete('link');
		window.history.replaceState({}, '', next.toString());
	});

	const linkedProviders = $derived(
		new Set(data.oauthAccounts.map((a: OAuthAccountSummary) => a.provider)),
	);
	const githubLinked = $derived(linkedProviders.has('github'));

	function providerLabel(provider: string): string {
		// Friendly name for known providers; falls back to raw string for
		// anything added later that doesn't have UI affordance yet.
		if (provider === 'github') return 'GitHub';
		return provider;
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

	// Plain navigation to the link-start endpoint. POST-via-form would
	// trip the CSP's `form-action 'self'` since the endpoint ultimately
	// redirects to github.com; top-level navigations aren't policed
	// the same way. Same shape as the existing /login GitHub link.
	const linkGithubHref = '/api/auth/oauth/github/link/start';

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

<div class="flex h-full flex-col overflow-hidden">
	<header class="shrink-0 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Security</h1>
		<p class="text-xs text-fg-muted">Manage how you sign in to this instance.</p>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<div class="mx-auto flex max-w-2xl flex-col gap-4">
			<section class="rounded-lg border border-border bg-surface-panel p-4">
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
								<div class="min-w-0 flex-1">
									<div class="font-medium">{providerLabel(a.provider)}</div>
									<div class="text-xs text-fg-muted">
										{a.externalUsername ? `@${a.externalUsername}` : `id ${a.externalId}`}
									</div>
								</div>
								{#if canUnlinkOAuth()}
									<button
										type="button"
										onclick={() => unlinkProvider(a.provider)}
										disabled={linkBusy}
										aria-label="Unlink provider"
										class="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-sunken hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
									>
										<Trash2 size={14} strokeWidth={2.25} />
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#if data.githubEnabled && !githubLinked}
					<div class="mt-4 border-t border-border pt-3">
						<a
							href={linkGithubHref}
							class="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm font-medium text-fg transition hover:bg-surface-sunken"
						>
							<Plus size={14} strokeWidth={2.25} />
							Link GitHub
						</a>
					</div>
				{/if}

				<dl class="mt-4 flex flex-col gap-1 border-t border-border pt-3 text-xs text-fg-muted">
					<div class="flex justify-between">
						<dt>GitHub OAuth login</dt>
						<dd class={data.githubEnabled ? 'text-fg' : 'text-fg-muted italic'}>
							{data.githubEnabled ? 'Enabled' : 'Disabled'}
						</dd>
					</div>
					<div class="flex justify-between">
						<dt>Passkey login</dt>
						<dd class={data.passkeyEnabled ? 'text-fg' : 'text-fg-muted italic'}>
							{data.passkeyEnabled ? 'Enabled' : 'Disabled'}
						</dd>
					</div>
				</dl>
			</section>

			<section class="rounded-lg border border-border bg-surface-panel p-4">
				<div class="flex items-baseline justify-between">
					<h2 class="text-sm font-semibold">Passkeys</h2>
					<span class="text-xs text-fg-muted">{data.passkeys.length} registered</span>
				</div>

				{#if data.passkeys.length === 0}
					<p class="mt-4 py-6 text-center text-sm text-fg-muted">
						No passkeys yet. Add one to sign in without GitHub.
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
												class="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-sunken hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
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
							<p
								class="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
							>
								{addError}
							</p>
						{/if}
					</div>
				{/if}
			</section>
		</div>
	</div>
</div>
