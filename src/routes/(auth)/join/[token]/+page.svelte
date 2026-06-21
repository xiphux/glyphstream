<script lang="ts">
	import { KeyRound } from '@lucide/svelte';
	import ProviderIcon from '$lib/components/ProviderIcon.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';

	let { data } = $props();

	let displayName = $state('');
	let email = $state('');
	let passkeyBusy = $state(false);
	let passkeyError = $state<string | null>(null);
	let oauthBusy = $state<string | null>(null);
	let oauthError = $state<string | null>(null);

	async function continueWithPasskey() {
		if (passkeyBusy) return;
		const name = displayName.trim();
		if (name.length === 0) {
			passkeyError = 'Pick a display name first.';
			return;
		}
		passkeyBusy = true;
		passkeyError = null;
		try {
			const { startRegistration } = await import('@simplewebauthn/browser');

			const optionsRes = await fetch('/api/auth/join/passkey/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: name, email: email.trim(), inviteToken: data.token }),
			});
			if (!optionsRes.ok) {
				passkeyError = await errorMessageFromResponse(optionsRes);
				return;
			}
			const optionsJSON = await optionsRes.json();

			let regResponse;
			try {
				regResponse = await startRegistration({ optionsJSON });
			} catch (e) {
				if (e instanceof DOMException && e.name === 'NotAllowedError') return;
				passkeyError = e instanceof Error ? e.message : String(e);
				return;
			}

			const verifyRes = await fetch('/api/auth/join/passkey/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response: regResponse }),
			});
			if (!verifyRes.ok) {
				passkeyError = await errorMessageFromResponse(verifyRes);
				return;
			}
			window.location.href = '/';
		} finally {
			passkeyBusy = false;
		}
	}

	async function continueWithProvider(providerId: string) {
		if (oauthBusy) return;
		const name = displayName.trim();
		if (name.length === 0) {
			oauthError = 'Pick a display name first.';
			return;
		}
		oauthBusy = providerId;
		oauthError = null;
		try {
			// AJAX-POST so the start endpoint can write its signed-carry cookie
			// before responding, then the client drives the navigation manually —
			// same CSP reasoning as the setup wizard.
			const res = await fetch(`/api/auth/oauth/${providerId}/join/start`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: name, email: email.trim(), inviteToken: data.token }),
			});
			if (!res.ok) {
				oauthError = await errorMessageFromResponse(res);
				return;
			}
			const { url } = (await res.json()) as { url: string };
			window.location.href = url;
		} finally {
			oauthBusy = null;
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-md">
		<div class="rounded-2xl border border-border bg-surface-panel p-8 shadow-sm">
			<h1 class="text-2xl font-semibold tracking-tight">Join GlyphStream</h1>
			<p class="mt-1 text-sm text-fg-muted">You've been invited to create an account.</p>

			{#if data.errorMessage}
				<div class="mt-4 rounded-lg border px-3 py-2 text-sm alert-danger">
					{data.errorMessage}
				</div>
			{/if}

			{#if !data.valid}
				<div class="mt-4 rounded-lg border px-3 py-2 text-sm alert-danger">
					This invite link is invalid, has expired, or has already been used. Ask your administrator
					for a new one.
				</div>
			{:else}
				<div class="mt-6 flex flex-col gap-3">
					<label class="block text-xs font-medium text-fg-muted" for="join-display-name">
						Display name
					</label>
					<input
						id="join-display-name"
						type="text"
						bind:value={displayName}
						maxlength="60"
						placeholder="What should the app call you?"
						class="rounded border border-border bg-surface-panel px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-fg"
					/>

					<label class="block text-xs font-medium text-fg-muted" for="join-email">
						Email <span class="opacity-70">(optional)</span>
					</label>
					<input
						id="join-email"
						type="email"
						bind:value={email}
						maxlength="120"
						placeholder="you@example.com"
						class="rounded border border-border bg-surface-panel px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-fg"
					/>
				</div>

				{#if passkeyError || oauthError}
					<div class="mt-4 rounded-lg border px-3 py-2 text-sm alert-danger">
						{passkeyError ?? oauthError}
					</div>
				{/if}

				{#each data.methods.providers as provider, i (provider.id)}
					<button
						type="button"
						onclick={() => continueWithProvider(provider.id)}
						disabled={oauthBusy !== null}
						class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-4 py-2.5 text-sm font-medium text-fg transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50 {i ===
						0
							? 'mt-6'
							: 'mt-3'}"
					>
						<ProviderIcon provider={provider.id} />
						{oauthBusy === provider.id ? 'Redirecting…' : `Continue with ${provider.label}`}
					</button>
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
						onclick={continueWithPasskey}
						disabled={passkeyBusy}
						class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-4 py-2.5 text-sm font-medium text-fg transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50 {data
							.methods.providers.length > 0
							? ''
							: 'mt-6'}"
					>
						<KeyRound size={16} strokeWidth={2.25} />
						{passkeyBusy ? 'Waiting for passkey…' : 'Set up a passkey'}
					</button>
				{/if}
			{/if}
		</div>
	</div>
</div>
