<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { LockKeyhole } from '@lucide/svelte';
	import { getAppLockAssertion } from '$lib/app-lock-ceremony';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let busy = $state(false);
	let unlockError = $state<string | null>(null);

	async function unlock() {
		if (busy) return;
		busy = true;
		unlockError = null;
		try {
			const assertion = await getAppLockAssertion();
			if (!assertion.ok) {
				unlockError = assertion.error;
				return;
			}
			const res = await fetch('/api/auth/unlock/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response: assertion.response }),
			});
			if (!res.ok) {
				unlockError = await errorMessageFromResponse(res);
				return;
			}
			// `data.from` is restricted to a same-origin path server-side.
			await goto(data.from, { replaceState: true, invalidateAll: true });
		} finally {
			busy = false;
		}
	}

	function signOut() {
		const f = document.createElement('form');
		f.method = 'POST';
		f.action = '/api/auth/logout';
		document.body.appendChild(f);
		f.submit();
	}

	// Prompt straight away — opening the app should go to Face ID the way a
	// locked native app does. Safari may refuse a ceremony that no tap started;
	// that surfaces as a dismissal, which leaves the button below to do it.
	onMount(() => {
		void unlock();
	});
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-sm">
		<div class="rounded-2xl border border-border bg-surface-panel p-8 text-center shadow-sm">
			<LockKeyhole class="mx-auto text-fg-muted" size={28} strokeWidth={2} />
			<h1 class="mt-3 text-2xl font-semibold tracking-tight">GlyphStream is locked</h1>
			<p class="mt-1 text-sm text-fg-muted">Use your passkey to continue.</p>

			{#if unlockError}
				<div class="mt-4 rounded-lg border px-3 py-2 text-left text-sm alert-danger">
					{unlockError}
				</div>
			{/if}

			<button
				type="button"
				onclick={unlock}
				disabled={busy}
				class="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-surface-inverse px-4 py-2.5 text-sm font-medium text-fg-inverse transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{busy ? 'Waiting for passkey…' : 'Unlock'}
			</button>
			<button
				type="button"
				onclick={signOut}
				class="mt-3 text-xs text-fg-muted underline-offset-2 hover:underline"
			>
				Sign out
			</button>
		</div>
	</div>
</div>
