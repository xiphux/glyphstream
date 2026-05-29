<script lang="ts">
	import { onMount } from 'svelte';
	import { Check } from '@lucide/svelte';
	import type { ColorScheme, EnterBehavior, ThemeName, UserPreferences } from '$lib/types/api';
	import {
		getPermissionState,
		isIosBeforeInstall,
		isPushSupported,
		loadPushConfig,
		subscribe as subscribeToPush,
		unsubscribe as unsubscribeFromPush
	} from '$lib/push-subscribe';

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

	// Theme has a live DOM side effect (the data-theme attribute + cookie),
	// so it applies immediately on select via selectTheme rather than the
	// shared saveField path.
	// svelte-ignore state_referenced_locally
	let theme = $state<ThemeName>(data.prefs.theme);
	let themeError = $state<string | null>(null);
	const THEMES: { id: ThemeName; label: string; description: string }[] = [
		{ id: 'glyphstream', label: 'GlyphStream', description: 'Signature liquid glass' },
		{ id: 'claude', label: 'Claude', description: 'Warm paper, soft edges' },
		{ id: 'chatgpt', label: 'ChatGPT', description: 'Cool, compact, flat' }
	];

	function applyThemeToDom(t: ThemeName) {
		const root = document.documentElement;
		if (t === 'glyphstream') delete root.dataset.theme;
		else root.dataset.theme = t;
		document.cookie = `gs-theme=${t}; path=/; max-age=31536000; samesite=lax`;
	}

	async function selectTheme(next: ThemeName) {
		if (theme === next) return;
		const prev = theme;
		// Apply instantly — the CSS-var cascade re-themes the whole app with
		// no reload; existing transitions give a soft cross-fade for free.
		theme = next;
		applyThemeToDom(next);
		themeError = null;
		const saved = await patchPrefs({ theme: next });
		if (!saved) {
			theme = prev;
			applyThemeToDom(prev);
			themeError = "Couldn't save theme — reverted.";
		}
	}

	// Light/dark/system — auto-saves, applies live (no reload). Resolves the
	// data-scheme attribute the same way app.html's inline script does.
	// svelte-ignore state_referenced_locally
	let colorScheme = $state<ColorScheme>(data.prefs.colorScheme);
	const SCHEMES: { id: ColorScheme; label: string }[] = [
		{ id: 'system', label: 'System' },
		{ id: 'light', label: 'Light' },
		{ id: 'dark', label: 'Dark' }
	];

	function applySchemeToDom(s: ColorScheme) {
		const dark =
			s === 'dark' ||
			(s !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
		document.documentElement.dataset.scheme = dark ? 'dark' : 'light';
		document.cookie = `gs-scheme=${s}; path=/; max-age=31536000; samesite=lax`;
	}

	async function selectScheme(next: ColorScheme) {
		if (colorScheme === next) return;
		const prev = colorScheme;
		colorScheme = next;
		applySchemeToDom(next);
		themeError = null;
		const ok = await patchPrefs({ colorScheme: next });
		if (!ok) {
			colorScheme = prev;
			applySchemeToDom(prev);
			themeError = "Couldn't save appearance — reverted.";
		}
	}

	// Last-persisted snapshot. Text fields compare against it on blur so a
	// no-op blur doesn't fire a redundant PATCH.
	// svelte-ignore state_referenced_locally
	let saved = $state<UserPreferences>({ ...data.prefs });
	let savedFlash = $state(false);
	let saveError = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;

	// Single auto-save path for every preference: PATCH, refresh the
	// snapshot, flash a quiet "Saved". (patchPrefs is declared below;
	// function declarations hoist, so calling it here is fine.)
	async function saveField(patch: Partial<UserPreferences>) {
		saveError = null;
		const next = await patchPrefs(patch);
		if (!next) {
			saveError = "Couldn't save — check your connection and try again.";
			return;
		}
		saved = { ...next };
		savedFlash = true;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (savedFlash = false), 1500);
	}

	// Text fields save on blur (not per keystroke), and only when changed.
	function saveTextField(field: 'name' | 'aboutYou' | 'customInstructions', value: string) {
		if (value === saved[field]) return;
		void saveField({ [field]: value });
	}

	// --- Notifications --------------------------------------------------
	// Auto-saved on toggle (separate from the form's Save button) because
	// the master switch has side effects — permission prompts and push
	// subscription writes — that can't be unwound by clicking Revert.

	// svelte-ignore state_referenced_locally
	let notificationsEnabled = $state(data.prefs.notificationsEnabled);
	// svelte-ignore state_referenced_locally
	let notificationsShowContent = $state(data.prefs.notificationsShowContent);
	// svelte-ignore state_referenced_locally
	let notificationsForegroundToast = $state(data.prefs.notificationsForegroundToast);

	let pushSupported = $state(false);
	let iosBeforeInstall = $state(false);
	let permissionState = $state<NotificationPermission>('default');
	let vapidPublicKey = $state<string | null>(null);
	let serverConfigured = $state<boolean | null>(null); // null = loading
	let notifBusy = $state(false);
	let notifError = $state<string | null>(null);

	const masterDisabled = $derived(
		notifBusy ||
			!pushSupported ||
			iosBeforeInstall ||
			permissionState === 'denied' ||
			serverConfigured === false
	);

	const masterDisabledReason = $derived(
		!pushSupported
			? 'This browser does not support Web Push.'
			: iosBeforeInstall
				? 'Install GlyphStream to your Home Screen first — iOS only delivers push to installed PWAs.'
				: permissionState === 'denied'
					? 'Notifications are blocked in browser settings. Enable them in your browser to turn this on.'
					: serverConfigured === false
						? 'Push notifications are not configured on this server.'
						: null
	);

	onMount(async () => {
		pushSupported = isPushSupported();
		iosBeforeInstall = isIosBeforeInstall();
		permissionState = getPermissionState();
		if (pushSupported) {
			const cfg = await loadPushConfig();
			serverConfigured = cfg?.enabled ?? false;
			vapidPublicKey = cfg?.vapidPublicKey ?? null;
		} else {
			serverConfigured = false;
		}
	});

	async function patchPrefs(patch: Partial<UserPreferences>): Promise<UserPreferences | null> {
		const res = await fetch('/api/user/preferences', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		});
		if (!res.ok) return null;
		return (await res.json()) as UserPreferences;
	}

	async function toggleMaster(next: boolean) {
		if (notifBusy) return;
		notifBusy = true;
		notifError = null;
		try {
			if (next) {
				if (!vapidPublicKey) {
					notifError = 'Server configuration missing — try reloading.';
					return;
				}
				const result = await subscribeToPush(vapidPublicKey);
				if (!result.ok) {
					notifError =
						result.reason === 'permission_denied'
							? 'Permission denied.'
							: result.reason === 'unsupported'
								? 'This browser does not support push notifications.'
								: result.reason === 'no_registration'
									? 'Service worker not active yet. Reload and try again.'
									: 'Could not register the subscription with the server.';
					permissionState = getPermissionState();
					return;
				}
				const saved = await patchPrefs({ notificationsEnabled: true });
				if (!saved) {
					notifError = 'Subscription saved on this device but server update failed.';
					return;
				}
				notificationsEnabled = true;
				permissionState = getPermissionState();
			} else {
				await unsubscribeFromPush();
				const saved = await patchPrefs({ notificationsEnabled: false });
				if (!saved) {
					notifError = 'Could not save your preference; try again.';
					return;
				}
				notificationsEnabled = false;
			}
		} catch (e) {
			notifError = e instanceof Error ? e.message : String(e);
		} finally {
			notifBusy = false;
		}
	}

	async function toggleShowContent(next: boolean) {
		if (notifBusy) return;
		notifBusy = true;
		notifError = null;
		try {
			const saved = await patchPrefs({ notificationsShowContent: next });
			if (saved) notificationsShowContent = saved.notificationsShowContent;
			else notifError = 'Could not save your preference; try again.';
		} finally {
			notifBusy = false;
		}
	}

	async function toggleForegroundToast(next: boolean) {
		if (notifBusy) return;
		notifBusy = true;
		notifError = null;
		try {
			const saved = await patchPrefs({ notificationsForegroundToast: next });
			if (saved) notificationsForegroundToast = saved.notificationsForegroundToast;
			else notifError = 'Could not save your preference; try again.';
		} finally {
			notifBusy = false;
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<header class="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
		<h1 class="text-lg font-semibold tracking-tight">Preferences</h1>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-4">
		<form
			onsubmit={(e) => e.preventDefault()}
			class="mx-auto flex max-w-2xl flex-col gap-6 rounded-lg border border-border bg-surface-panel p-4"
		>
			<section class="flex flex-col gap-3">
				<div>
					<h2 class="text-sm font-semibold">Personalization</h2>
					<p class="mt-0.5 text-xs text-fg-muted">
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
						onblur={() => saveTextField('name', name)}
						placeholder="Your name or nickname"
						class="w-full rounded-md border border-border bg-surface-panel px-3 py-2 text-base shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50 sm:text-sm"
					/>
				</div>

				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-medium" for="pref-about">About you</label>
					<textarea
						id="pref-about"
						bind:value={aboutYou}
						rows="3"
						maxlength={2000}
						onblur={() => saveTextField('aboutYou', aboutYou)}
						placeholder="Background, interests, or other standing context to keep in mind"
						class="w-full resize-y rounded-md border border-border bg-surface-panel px-3 py-2 text-base shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50 sm:text-sm"
					></textarea>
				</div>

				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-medium" for="pref-custom">Custom instructions</label>
					<textarea
						id="pref-custom"
						bind:value={customInstructions}
						rows="6"
						maxlength={4000}
						onblur={() => saveTextField('customInstructions', customInstructions)}
						placeholder="Response style, tone, or formatting preferences"
						class="w-full resize-y rounded-md border border-border bg-surface-panel px-3 py-2 text-base shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50 sm:text-sm"
					></textarea>
				</div>
			</section>

			<div class="border-t border-border"></div>

			<section class="flex flex-col gap-2">
				<div>
					<h2 class="text-sm font-semibold">Composer</h2>
					<p class="mt-0.5 text-xs text-fg-muted">
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
							onchange={() => {
								enterBehavior = 'send';
								void saveField({ enterBehavior: 'send' });
							}}
							class="mt-0.5"
						/>
						<span>
							<span class="font-medium">Enter sends</span>
							<span class="text-fg-muted">
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
							onchange={() => {
								enterBehavior = 'newline';
								void saveField({ enterBehavior: 'newline' });
							}}
							class="mt-0.5"
						/>
						<span>
							<span class="font-medium">Enter inserts a newline</span>
							<span class="text-fg-muted">
								— Cmd/Ctrl+Enter sends.
							</span>
						</span>
					</label>
				</div>
			</section>

			<div class="border-t border-border"></div>

			<section class="flex flex-col gap-2">
				<h2 class="text-sm font-semibold">New chat page</h2>
				<label class="flex cursor-pointer items-start gap-2 text-sm">
					<input
						type="checkbox"
						bind:checked={showGreeting}
						onchange={() => void saveField({ showGreeting })}
						class="mt-0.5"
					/>
					<span>
						<span class="font-medium">Show greeting</span>
						<span class="text-fg-muted">
							— "Good morning, Chris" header above the message composer.
						</span>
					</span>
				</label>
			</section>

			<div class="border-t border-border"></div>

			<section class="flex flex-col gap-2">
				<div>
					<h2 class="text-sm font-semibold">Theme</h2>
					<p class="mt-0.5 text-xs text-fg-muted">
						Pick a visual style. Light vs dark within each follows your system
						setting. Applies instantly.
					</p>
				</div>
				<div class="grid grid-cols-3 gap-2">
					{#each THEMES as t (t.id)}
						<button
							type="button"
							onclick={() => selectTheme(t.id)}
							aria-pressed={theme === t.id}
							class="flex flex-col gap-1 rounded-lg border p-3 text-left transition {theme ===
							t.id
								? 'border-border-focus bg-surface-sunken'
								: 'border-border hover:bg-surface-raised'}"
						>
							<span class="text-sm font-medium">{t.label}</span>
							<span class="text-xs text-fg-muted">{t.description}</span>
						</button>
					{/each}
				</div>
				<div class="mt-1 flex items-center gap-2">
					<span class="text-xs text-fg-muted">Mode:</span>
					{#each SCHEMES as s (s.id)}
						<button
							type="button"
							onclick={() => selectScheme(s.id)}
							aria-pressed={colorScheme === s.id}
							class="rounded-md border px-3 py-1 text-xs transition {colorScheme === s.id
								? 'border-border-focus bg-surface-sunken'
								: 'border-border hover:bg-surface-raised'}"
						>
							{s.label}
						</button>
					{/each}
				</div>
				{#if themeError}
					<p class="text-xs text-red-600 dark:text-red-400">{themeError}</p>
				{/if}
			</section>

			<div class="border-t border-border"></div>

			<section class="flex flex-col gap-3">
				<div>
					<h2 class="text-sm font-semibold">Notifications</h2>
					<p class="mt-0.5 text-xs text-fg-muted">
						Ping you when an assistant message finishes — toast when you're in
						the app on a different page, OS notification when you've switched
						apps or locked your phone. On iOS this needs the PWA installed to
						the Home Screen first.
					</p>
				</div>

				<label class="flex cursor-pointer items-start gap-2 text-sm">
					<input
						type="checkbox"
						checked={notificationsEnabled}
						onchange={(e) => toggleMaster(e.currentTarget.checked)}
						disabled={masterDisabled}
						class="mt-0.5"
					/>
					<span>
						<span class="font-medium">Enable notifications</span>
						<span class="text-fg-muted">
							— receive push notifications on this device when a message
							completes.
						</span>
					</span>
				</label>

				{#if masterDisabledReason}
					<div
						class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
					>
						{masterDisabledReason}
					</div>
				{:else if pushSupported}
					<div class="text-xs text-fg-muted">
						Permission: <span class="font-mono">{permissionState}</span>
					</div>
				{/if}

				<label
					class="flex cursor-pointer items-start gap-2 text-sm"
					class:opacity-50={!notificationsEnabled}
				>
					<input
						type="checkbox"
						checked={notificationsShowContent}
						onchange={(e) => toggleShowContent(e.currentTarget.checked)}
						disabled={!notificationsEnabled || notifBusy}
						class="mt-0.5"
					/>
					<span>
						<span class="font-medium">Show message preview</span>
						<span class="text-fg-muted">
							— include a snippet of the assistant's reply in the notification
							body. Turn off if your threads are private to the device.
						</span>
					</span>
				</label>

				<label
					class="flex cursor-pointer items-start gap-2 text-sm"
					class:opacity-50={!notificationsEnabled}
				>
					<input
						type="checkbox"
						checked={notificationsForegroundToast}
						onchange={(e) => toggleForegroundToast(e.currentTarget.checked)}
						disabled={!notificationsEnabled || notifBusy}
						class="mt-0.5"
					/>
					<span>
						<span class="font-medium">In-app toast for other threads</span>
						<span class="text-fg-muted">
							— pop a toast when a thread completes while you're on a different
							page. Turn off to only get OS-level notifications when the app is
							backgrounded.
						</span>
					</span>
				</label>

				{#if notifError}
					<div
						class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
					>
						{notifError}
					</div>
				{/if}
			</section>

			{#if saveError}
				<div
					class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
				>
					{saveError}
				</div>
			{/if}

			<!-- Auto-save confirmation flash. Fixed height so the row doesn't
				 jump when "Saved" appears/clears; no resting-state label since
				 the absence of a Save button already implies auto-save. -->
			<div class="flex h-5 items-center justify-end text-xs">
				{#if savedFlash}
					<span class="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
						<Check size={14} strokeWidth={2.5} />
						Saved
					</span>
				{/if}
			</div>
		</form>
	</div>
</div>
