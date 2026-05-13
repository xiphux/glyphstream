<script lang="ts">
	import { Check } from 'lucide-svelte';
	import type { EnterBehavior, UserPreferences } from '$lib/types/api';

	let { data } = $props<{ data: { prefs: UserPreferences } }>();

	// Form state. Snapshot data.prefs once at mount — the form is the
	// source of truth between mount and Save, so we don't want each
	// data prop update to clobber in-progress edits.
	// svelte-ignore state_referenced_locally
	let name = $state(data.prefs.name);
	// svelte-ignore state_referenced_locally
	let aboutYou = $state(data.prefs.aboutYou);
	// svelte-ignore state_referenced_locally
	let customInstructions = $state(data.prefs.customInstructions);
	// svelte-ignore state_referenced_locally
	let enterBehavior = $state<EnterBehavior>(data.prefs.enterBehavior);
	// svelte-ignore state_referenced_locally
	let showGreeting = $state(data.prefs.showGreeting);

	// svelte-ignore state_referenced_locally
	let saved = $state<UserPreferences>({ ...data.prefs });
	let busy = $state(false);
	let error = $state<string | null>(null);
	let justSaved = $state(false);

	const dirty = $derived(
		name !== saved.name ||
			aboutYou !== saved.aboutYou ||
			customInstructions !== saved.customInstructions ||
			enterBehavior !== saved.enterBehavior ||
			showGreeting !== saved.showGreeting
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
				body: JSON.stringify({
					name,
					aboutYou,
					customInstructions,
					enterBehavior,
					showGreeting
				})
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
			}
			const next = (await res.json()) as UserPreferences;
			saved = { ...next };
			name = next.name;
			aboutYou = next.aboutYou;
			customInstructions = next.customInstructions;
			enterBehavior = next.enterBehavior;
			showGreeting = next.showGreeting;
			justSaved = true;
			setTimeout(() => (justSaved = false), 2000);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function revert() {
		name = saved.name;
		aboutYou = saved.aboutYou;
		customInstructions = saved.customInstructions;
		enterBehavior = saved.enterBehavior;
		showGreeting = saved.showGreeting;
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
			<section class="flex flex-col gap-3">
				<div>
					<h2 class="text-sm font-semibold">Personalization</h2>
					<p class="mt-0.5 text-xs text-neutral-500">
						Composed into a system prompt for new conversations (when not using a
						custom-model preset). Doesn't change existing chats — only future ones.
						Empty fields are omitted entirely.
					</p>
				</div>

				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-medium" for="pref-name">Name</label>
					<input
						id="pref-name"
						bind:value={name}
						type="text"
						maxlength={100}
						disabled={busy}
						placeholder="Your name or nickname"
						class="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
					/>
				</div>

				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-medium" for="pref-about">About you</label>
					<textarea
						id="pref-about"
						bind:value={aboutYou}
						rows="3"
						maxlength={2000}
						disabled={busy}
						placeholder="Background, interests, or other standing context to keep in mind"
						class="w-full resize-y rounded-md border border-neutral-200 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
					></textarea>
				</div>

				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-medium" for="pref-custom">Custom instructions</label>
					<textarea
						id="pref-custom"
						bind:value={customInstructions}
						rows="6"
						maxlength={4000}
						disabled={busy}
						placeholder="Response style, tone, or formatting preferences"
						class="w-full resize-y rounded-md border border-neutral-200 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
					></textarea>
				</div>
			</section>

			<div class="border-t border-neutral-200 dark:border-neutral-800"></div>

			<section class="flex flex-col gap-2">
				<div>
					<h2 class="text-sm font-semibold">Composer</h2>
					<p class="mt-0.5 text-xs text-neutral-500">
						How the message composer treats the Enter key.
					</p>
				</div>
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
			</section>

			<div class="border-t border-neutral-200 dark:border-neutral-800"></div>

			<section class="flex flex-col gap-2">
				<h2 class="text-sm font-semibold">New chat page</h2>
				<label class="flex cursor-pointer items-start gap-2 text-sm">
					<input
						type="checkbox"
						bind:checked={showGreeting}
						disabled={busy}
						class="mt-0.5"
					/>
					<span>
						<span class="font-medium">Show greeting</span>
						<span class="text-neutral-500">
							— "Good morning, Chris" header above the message composer.
						</span>
					</span>
				</label>
			</section>

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
