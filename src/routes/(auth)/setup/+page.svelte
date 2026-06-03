<script lang="ts">
	import { KeyRound } from '@lucide/svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';

	let { data } = $props();

	let displayName = $state('');
	let email = $state('');
	let passkeyBusy = $state(false);
	let passkeyError = $state<string | null>(null);

	function tokenSuffix(): string {
		// Carry the operator-supplied setup token through to the API
		// endpoints; they re-run setupGate against this query string.
		return data.token ? `?token=${encodeURIComponent(data.token)}` : '';
	}

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

			const optionsRes = await fetch(`/api/auth/setup/passkey/options${tokenSuffix()}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: name, email: email.trim() }),
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

			const verifyRes = await fetch(`/api/auth/setup/passkey/verify${tokenSuffix()}`, {
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

	function continueWithGithub() {
		// Submit as a POST form so the start endpoint can write its
		// signed-carry cookie atomically alongside the redirect.
		const form = document.createElement('form');
		form.method = 'POST';
		form.action = `/api/auth/setup/github/start${tokenSuffix()}`;
		form.style.display = 'none';
		for (const [name, value] of [
			['displayName', displayName.trim()],
			['email', email.trim()],
		]) {
			const input = document.createElement('input');
			input.type = 'hidden';
			input.name = name;
			input.value = value;
			form.appendChild(input);
		}
		document.body.appendChild(form);
		form.submit();
	}
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-md">
		<div class="rounded-2xl border border-border bg-surface-panel p-8 shadow-sm">
			<h1 class="text-2xl font-semibold tracking-tight">Welcome to GlyphStream</h1>
			<p class="mt-1 text-sm text-fg-muted">
				Set up your operator account. This page closes as soon as the first user exists.
			</p>

			{#if data.errorMessage}
				<div
					class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
				>
					{data.errorMessage}
				</div>
			{/if}

			{#if data.gated}
				<div
					class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
				>
					This instance requires a setup token. Visit /setup?token=&lt;value&gt; with the
					<code class="font-mono text-xs">SETUP_TOKEN</code> configured in
					<code class="font-mono text-xs">.env</code>.
				</div>
			{:else}
				<div class="mt-6 flex flex-col gap-3">
					<label class="block text-xs font-medium text-fg-muted" for="setup-display-name">
						Display name
					</label>
					<input
						id="setup-display-name"
						type="text"
						bind:value={displayName}
						maxlength="60"
						placeholder="What should the app call you?"
						class="rounded border border-border bg-surface-panel px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-fg"
					/>

					<label class="block text-xs font-medium text-fg-muted" for="setup-email">
						Email <span class="opacity-70">(optional)</span>
					</label>
					<input
						id="setup-email"
						type="email"
						bind:value={email}
						maxlength="120"
						placeholder="you@example.com"
						class="rounded border border-border bg-surface-panel px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-fg"
					/>
				</div>

				{#if passkeyError}
					<div
						class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
					>
						{passkeyError}
					</div>
				{/if}

				{#if data.methods.github}
					<button
						type="button"
						onclick={continueWithGithub}
						class="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-surface-inverse px-4 py-2.5 text-sm font-medium text-fg-inverse transition hover:opacity-90"
					>
						<svg viewBox="0 0 24 24" class="h-4 w-4" aria-hidden="true" fill="currentColor">
							<path
								d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.27-.01-1.18-.02-2.14-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.27-1.7-1.27-1.7-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18a10.93 10.93 0 0 1 5.74 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.05.78 2.13 0 1.54-.01 2.79-.01 3.16 0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z"
							/>
						</svg>
						Continue with GitHub
					</button>
				{/if}

				{#if data.methods.github && data.methods.passkey}
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
							.methods.github
							? ''
							: 'mt-6'}"
					>
						<KeyRound size={16} strokeWidth={2.25} />
						{passkeyBusy ? 'Waiting for passkey…' : 'Set up a passkey'}
					</button>
				{/if}
			{/if}
		</div>

		<p class="mt-4 text-center text-xs text-fg-muted">
			This page is reachable only while no user exists.
		</p>
	</div>
</div>
