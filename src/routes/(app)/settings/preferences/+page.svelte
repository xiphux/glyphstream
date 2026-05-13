<script lang="ts">
	import { Check } from 'lucide-svelte';
	import type { EnterBehavior, UserPreferences } from '$lib/types/api';

	let { data } = $props<{ data: { prefs: UserPreferences } }>();

	// Form-state mirrors the loaded prefs but lives independently so the
	// user can type freely without us round-tripping every keystroke to
	// the server. PATCH only fires on Save. We deliberately snapshot
	// data.prefs once at mount rather than tracking it reactively —
	// the form is the source of truth between mount and Save.
	// svelte-ignore state_referenced_locally
	let systemPrompt = $state(data.prefs.systemPrompt);
	// svelte-ignore state_referenced_locally
	let enterBehavior = $state<EnterBehavior>(data.prefs.enterBehavior);

	// Track the last-saved values so we can show a clean "no changes"
	// state and disable Save when the form matches what's on the server.
	// svelte-ignore state_referenced_locally
	let saved = $state<UserPreferences>({ ...data.prefs });
	let busy = $state(false);
	let error = $state<string | null>(null);
	let justSaved = $state(false);

	const dirty = $derived(
		systemPrompt !== saved.systemPrompt || enterBehavior !== saved.enterBehavior
	);

	async function save() {
		if (busy || !dirty) return;
		busy = true;
		error = null;
		justSaved = false;
		try {
			const res = await fetch('/api/user/preferences', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ systemPrompt, enterBehavior })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
			}
			const next = (await res.json()) as UserPreferences;
			saved = { ...next };
			systemPrompt = next.systemPrompt;
			enterBehavior = next.enterBehavior;
			justSaved = true;
			// Hide the "Saved" badge after a moment.
			setTimeout(() => (justSaved = false), 2000);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function revert() {
		systemPrompt = saved.systemPrompt;
		enterBehavior = saved.enterBehavior;
		error = null;
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Preferences</h1>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<form
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
			class="mx-auto flex max-w-2xl flex-col gap-6 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
		>
			<div class="flex flex-col gap-2">
				<label class="text-sm font-medium" for="system-prompt">
					Default system prompt
				</label>
				<p class="text-xs text-neutral-500">
					Applied as the system prompt for new conversations that aren't using a
					custom-model preset. Empty = no system prompt. Doesn't change existing
					conversations — only new ones.
				</p>
				<textarea
					id="system-prompt"
					bind:value={systemPrompt}
					rows="6"
					disabled={busy}
					placeholder="Always respond concisely. Use bullet points when listing things."
					class="w-full resize-y rounded-md border border-neutral-200 bg-white px-3 py-2 font-mono text-base shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:text-xs dark:border-neutral-700 dark:bg-neutral-900"
				></textarea>
			</div>

			<div class="flex flex-col gap-2">
				<span class="text-sm font-medium">Enter key behavior</span>
				<p class="text-xs text-neutral-500">
					How the message composer treats the Enter key.
				</p>
				<div class="flex flex-col gap-2 text-sm">
					<label class="flex cursor-pointer items-start gap-2">
						<input
							type="radio"
							name="enter-behavior"
							value="send"
							checked={enterBehavior === 'send'}
							onchange={() => (enterBehavior = 'send')}
							disabled={busy}
							class="mt-0.5"
						/>
						<span>
							<span class="font-medium">Enter sends</span>
							<span class="text-neutral-500">
								— Shift+Enter inserts a newline. (Default.)
							</span>
						</span>
					</label>
					<label class="flex cursor-pointer items-start gap-2">
						<input
							type="radio"
							name="enter-behavior"
							value="newline"
							checked={enterBehavior === 'newline'}
							onchange={() => (enterBehavior = 'newline')}
							disabled={busy}
							class="mt-0.5"
						/>
						<span>
							<span class="font-medium">Enter inserts a newline</span>
							<span class="text-neutral-500">
								— Cmd/Ctrl+Enter sends.
							</span>
						</span>
					</label>
				</div>
			</div>

			{#if error}
				<div
					class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
				>
					{error}
				</div>
			{/if}

			<div class="flex items-center justify-end gap-2">
				{#if justSaved}
					<span class="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
						<Check size={14} strokeWidth={2.5} />
						Saved
					</span>
				{/if}
				{#if dirty}
					<button
						type="button"
						onclick={revert}
						disabled={busy}
						class="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
					>
						Revert
					</button>
				{/if}
				<button
					type="submit"
					disabled={!dirty || busy}
					class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
				>
					{busy ? 'Saving…' : 'Save'}
				</button>
			</div>
		</form>
	</div>
</div>
