<script lang="ts">
	import { KeyRound } from '@lucide/svelte';
	import ProviderIcon from '$lib/components/ProviderIcon.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import { clearSessionScopedClientState } from '$lib/client-session-state';

	let { data } = $props();

	// Reaching the login page means there's no live session — an explicit
	// logout, or an expired/revoked one bounced here by the (app) layout. Wipe
	// device-local client state (composer drafts, sidebar-collapsed) so it can't
	// leak to the next person who signs in on this browser. The page's server
	// load redirects authenticated users to '/', so this only runs while
	// genuinely signed out. $effect (not onMount) so it runs purely client-side
	// without SSR ceremony.
	$effect(() => {
		clearSessionScopedClientState();
	});

	let passkeyBusy = $state(false);
	let passkeyError = $state<string | null>(null);

	async function signInWithPasskey() {
		if (passkeyBusy) return;
		passkeyBusy = true;
		passkeyError = null;
		try {
			// Dynamic-import the WebAuthn browser shim so GitHub-only deploys
			// don't pay its ~5 KB on the critical path.
			const { startAuthentication } = await import('@simplewebauthn/browser');

			const optionsRes = await fetch('/api/auth/passkey/login/options', { method: 'POST' });
			if (!optionsRes.ok) {
				passkeyError = await errorMessageFromResponse(optionsRes);
				return;
			}
			const optionsJSON = await optionsRes.json();

			let authResponse;
			try {
				authResponse = await startAuthentication({ optionsJSON });
			} catch (e) {
				// NotAllowedError = user dismissed the picker. Swallow silently.
				if (e instanceof DOMException && e.name === 'NotAllowedError') return;
				passkeyError = e instanceof Error ? e.message : String(e);
				return;
			}

			const verifyRes = await fetch('/api/auth/passkey/login/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response: authResponse }),
			});
			if (!verifyRes.ok) {
				passkeyError = await errorMessageFromResponse(verifyRes);
				return;
			}
			// Full navigation rather than SPA — picks up the new session
			// cookie cleanly and runs the (app) layout's auth gate from a
			// fresh page load.
			window.location.href = '/';
		} finally {
			passkeyBusy = false;
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-sm">
		<div class="rounded-2xl border border-border bg-surface-panel p-8 shadow-sm">
			<h1 class="text-2xl font-semibold tracking-tight">GlyphStream</h1>
			<p class="mt-1 text-sm text-fg-muted">Sign in to continue.</p>

			{#if data.errorMessage}
				<div class="mt-4 rounded-lg border px-3 py-2 text-sm alert-danger">
					{data.errorMessage}
				</div>
			{/if}

			{#if passkeyError}
				<div class="mt-4 rounded-lg border px-3 py-2 text-sm alert-danger">
					{passkeyError}
				</div>
			{/if}

			{#each data.methods.providers as provider, i (provider.id)}
				<a
					href="/api/auth/oauth/{provider.id}/login"
					class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-4 py-2.5 text-sm font-medium text-fg transition hover:bg-surface-sunken {i ===
					0
						? 'mt-6'
						: 'mt-3'}"
				>
					<ProviderIcon provider={provider.id} />
					Sign in with {provider.label}
				</a>
			{/each}

			{#if data.methods.providers.length > 0 && data.methods.passkey}
				<div class="my-4 flex items-center gap-3 text-xs text-fg-muted">
					<span class="h-px flex-1 bg-border"></span>
					<span>or</span>
					<span class="h-px flex-1 bg-border"></span>
				</div>
			{/if}

			{#if data.methods.passkey}
				<button
					type="button"
					onclick={signInWithPasskey}
					disabled={passkeyBusy}
					class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-4 py-2.5 text-sm font-medium text-fg transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50 {data
						.methods.providers.length > 0
						? ''
						: 'mt-6'}"
				>
					<KeyRound size={16} strokeWidth={2.25} />
					{passkeyBusy ? 'Waiting for passkey…' : 'Sign in with a passkey'}
				</button>
			{/if}
		</div>

		<p class="mt-4 text-center text-xs text-fg-muted">Self-hosted. Closed registration.</p>
	</div>
</div>
