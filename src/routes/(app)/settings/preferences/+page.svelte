<script lang="ts">
	import { invalidate } from '$app/navigation';
	import SettingsPage from '$lib/components/settings/SettingsPage.svelte';
	import { onMount } from 'svelte';
	import { Check } from '@lucide/svelte';
	import type {
		ColorScheme,
		EnterBehavior,
		FeatureCategory,
		FeatureCategoryEntry,
		ThemeName,
		UserPreferences,
	} from '$lib/types/api';
	import { syncThemeColorMeta } from '$lib/theme-color';
	import {
		deviceNotificationGap,
		getPermissionState,
		hasLiveDeviceSubscription,
		isIosBeforeInstall,
		isPushSupported,
		loadPushConfig,
		reconcileSubscription,
		subscribe as subscribeToPush,
		type SubscribeResult,
		unsubscribe as unsubscribeFromPush,
	} from '$lib/push-subscribe';

	let { data } = $props<{
		data: { prefs: UserPreferences; featureCategories: FeatureCategoryEntry[] };
	}>();

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

	// Standing per-user defaults for the conversation feature toggles. Stored as
	// the DISABLED set (matching `conversations.disabled_features` and the
	// composer's menu) but rendered as "on" checkboxes, because the question a
	// user is answering here is "which of these do I want in a new chat".
	// svelte-ignore state_referenced_locally
	let defaultDisabledFeatures = $state<FeatureCategory[]>([
		...(data.prefs.defaultDisabledFeatures ?? []),
	]);

	// The (app) layout defers this list to `[]` on a full-document load (see its
	// `deferred` branch) and refills it from the client's post-mount invalidate.
	// Every other consumer is a menu opened well after mount; this section is
	// primary page content on first paint, so it needs the same emptiness guard
	// `settings/models` uses — otherwise a bookmarked or refreshed visit paints a
	// heading and explanation with no checkboxes under it, and offline it stays
	// that way.
	const visibleFeatureCategories = $derived(data.featureCategories);

	function featureEnabledByDefault(id: FeatureCategory): boolean {
		return !defaultDisabledFeatures.includes(id);
	}

	/** Monotonic token so an older in-flight save can't write its answer over a
	 *  newer one. Two quick clicks send two FULL arrays; without this, responses
	 *  landing out of order leave the server holding the earlier one while the UI
	 *  shows the later — invisibly, since nothing re-reads this state afterwards. */
	let featureSaveToken = 0;

	async function setFeatureDefault(id: FeatureCategory, enabled: boolean) {
		const prev = defaultDisabledFeatures;
		const next = enabled
			? defaultDisabledFeatures.filter((c) => c !== id)
			: [...new Set([...defaultDisabledFeatures, id])];
		// Optimistic so the checkbox responds immediately.
		defaultDisabledFeatures = next;
		const token = ++featureSaveToken;
		const confirmed = await saveField({ defaultDisabledFeatures: next });
		if (token !== featureSaveToken) return; // superseded by a later click
		// Adopt the server's answer, or put the checkbox back. Leaving a failed
		// change on screen is worse than it looks: the NEXT toggle computes its
		// array from this one, so a change the user was told had failed would ride
		// along and get persisted silently.
		// `?? []` for the same reason as the init read above: against a rolled-back
		// server the key is absent, and spreading undefined here would throw inside
		// an async handler — an unhandled rejection with the checkbox stuck.
		defaultDisabledFeatures = confirmed ? [...(confirmed.defaultDisabledFeatures ?? [])] : prev;
	}

	// svelte-ignore state_referenced_locally
	let autoCompactionEnabled = $state(data.prefs.autoCompactionEnabled);
	// svelte-ignore state_referenced_locally
	let autoCompactionThreshold = $state(data.prefs.autoCompactionThreshold);

	// Threshold saves on change, clamped to 1–100. Reverts the input to the
	// last-saved value if the PATCH is rejected.
	async function saveThreshold(raw: number) {
		const next = Math.min(100, Math.max(1, Math.round(raw || 0)));
		autoCompactionThreshold = next;
		if (next === saved.autoCompactionThreshold) return;
		await saveField({ autoCompactionThreshold: next });
		autoCompactionThreshold = saved.autoCompactionThreshold;
	}

	// Theme has a live DOM side effect (the data-theme attribute + cookie),
	// so it applies immediately on select via selectTheme rather than the
	// shared saveField path.
	// svelte-ignore state_referenced_locally
	let theme = $state<ThemeName>(data.prefs.theme);
	let themeError = $state<string | null>(null);
	const THEMES: Array<{ id: ThemeName; label: string; description: string }> = [
		{ id: 'glyphstream', label: 'GlyphStream', description: 'Signature frosted glass' },
		{ id: 'claude', label: 'Claude', description: 'Warm paper, soft edges' },
		{ id: 'chatgpt', label: 'ChatGPT', description: 'Cool, compact, flat' },
	];

	function applyThemeToDom(t: ThemeName) {
		const root = document.documentElement;
		if (t === 'glyphstream') delete root.dataset.theme;
		else root.dataset.theme = t;
		document.cookie = `gs-theme=${t}; path=/; max-age=31536000; samesite=lax`;
		syncThemeColorMeta();
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
	const SCHEMES: Array<{ id: ColorScheme; label: string }> = [
		{ id: 'system', label: 'System' },
		{ id: 'light', label: 'Light' },
		{ id: 'dark', label: 'Dark' },
	];

	function applySchemeToDom(s: ColorScheme) {
		const dark =
			s === 'dark' || (s !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
		document.documentElement.dataset.scheme = dark ? 'dark' : 'light';
		document.cookie = `gs-scheme=${s}; path=/; max-age=31536000; samesite=lax`;
		syncThemeColorMeta();
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
	// Plain `let`, not $state — the last-known-server value, compared against
	// inside the save handlers to skip no-op PATCHes and to revert on failure.
	// Nothing renders it, so $state would only deep-proxy the object for nothing.
	//
	// The svelte-ignore below is STILL LIVE and must stay, despite `saved` no
	// longer being a rune: `state_referenced_locally` fires on the *read* of
	// `data.prefs` — `data` is a prop binding, read here at top-level script
	// depth — not on what it is assigned to. Delete it and `pnpm check` warns.
	// (Three separate reviewers have mis-read this as vestigial; it isn't.)
	// svelte-ignore state_referenced_locally
	let saved: UserPreferences = { ...data.prefs };
	let savedFlash = $state(false);
	let saveError = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;

	// Single auto-save path for every preference: PATCH, refresh the
	// snapshot, flash a quiet "Saved". (patchPrefs is declared below;
	// function declarations hoist, so calling it here is fine.)
	/**
	 * Preferences the (app) LAYOUT feeds forward to other pages, so a save has to
	 * re-run its load or the rest of the session keeps a stale copy.
	 *
	 * `chat/[id]` deliberately never calls `await parent()` and never re-reads
	 * prefs itself (see CLAUDE.md), so `data.prefs` there is exactly what the
	 * layout last returned — a client-side navigation will not refresh it. Every
	 * field below is read off `data.prefs` somewhere outside this page, verified
	 * by grep rather than assumed:
	 *   - defaultDisabledFeatures → the new-chat composer's toggle seed
	 *   - enterBehavior, showGreeting → the composer and the greeting header
	 *   - name → `preferredFirstName` on both the new-chat and chat pages
	 *   - autoCompaction* → the chat page's compaction controller
	 *
	 * The rest (About you, Custom instructions, the notification toggles) really
	 * is page-local, and invalidating for those re-ran the whole layout load —
	 * conversations, models, skills, the feature catalogue — for nothing, on
	 * every blur. Add to this list rather than widening it to everything.
	 */
	const LAYOUT_FED_PREFS = new Set<keyof UserPreferences>([
		'defaultDisabledFeatures',
		'enterBehavior',
		'showGreeting',
		'name',
		'autoCompactionEnabled',
		'autoCompactionThreshold',
	]);

	async function saveField(patch: Partial<UserPreferences>): Promise<UserPreferences | null> {
		saveError = null;
		const next = await patchPrefs(patch);
		if (!next) {
			saveError = "Couldn't save — check your connection and try again.";
			return null;
		}
		saved = { ...next };
		savedFlash = true;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (savedFlash = false), 1500);
		// Deliberately NOT awaited, and deliberately after the flash: the save is
		// already committed, so gating the "Saved" indicator on a full layout reload
		// (measured at 751ms cold, per the layout's own note) would make a
		// successful save feel like a hang.
		if (Object.keys(patch).some((k) => LAYOUT_FED_PREFS.has(k as keyof UserPreferences))) {
			void invalidate('app:prefs');
		}
		return next;
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
	// null = still probing. Gates the gap banner so it can't flash on mount
	// before we know whether this device actually holds a subscription.
	let deviceSubscribed = $state<boolean | null>(null);
	// Bumped by every handler that changes this device's subscription. The mount
	// probe reads the browser asynchronously, so without this a probe that
	// started before a subscribe can land after it and overwrite the fresh
	// `true` with its stale `false` — raising "subscription has lapsed" directly
	// on top of a successful enable, until the next reload.
	let deviceProbeGeneration = 0;

	const masterDisabled = $derived(
		notifBusy ||
			!pushSupported ||
			iosBeforeInstall ||
			permissionState === 'denied' ||
			serverConfigured === false,
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
						: null,
	);

	// `notificationsEnabled` is one row per USER; a push subscription is per
	// device+install. So this page can render a checked box on a device that
	// receives nothing — which is exactly what an iOS PWA delete/re-add
	// produces (permission resets to `default`, the subscription is gone, the
	// pref is untouched). Nothing healed it silently either: reconciliation
	// must never prompt, so the one cause it can't fix is the common one.
	// Surface it explicitly instead of leaving the contradiction on screen.
	const deviceGap = $derived(
		deviceSubscribed === null
			? 'none'
			: deviceNotificationGap({
					enabled: notificationsEnabled,
					blocked: masterDisabledReason !== null,
					permission: permissionState,
					hasLiveSubscription: deviceSubscribed,
				}),
	);

	onMount(async () => {
		pushSupported = isPushSupported();
		iosBeforeInstall = isIosBeforeInstall();
		permissionState = getPermissionState();
		// Snapshot before the first await: the master toggle is live during the
		// config fetch (masterDisabled reads serverConfigured === false, and it is
		// null while loading), so a subscribe started in that window would bump
		// the counter before we read it and the stale probe would sail through
		// the equality check it exists to fail.
		const generation = deviceProbeGeneration;
		if (pushSupported) {
			const cfg = await loadPushConfig();
			serverConfigured = cfg?.enabled ?? false;
			vapidPublicKey = cfg?.vapidPublicKey ?? null;
			// Reconcile before probing, so a heal in flight can't read as "not
			// subscribed" and raise a banner for a gap about to close on its own.
			// This does NOT suppress the layout's own unawaited reconcile, which
			// still runs concurrently on a cold load — it only guarantees that
			// *some* heal has finished before we probe, which is what the probe
			// needs. The overlap is benign for register-existing and subscribe-new,
			// which are idempotent; a concurrent `resubscribe` (rotated key) is a
			// teardown-then-create, so a probe landing inside its window can read
			// null and raise the banner on a device about to be fine. That needs a
			// key rotation on a cold load, and the next load clears it. No-op (and no
			// prompt) unless opted in and already granted. Also the only heal on a
			// client-side nav here, where layout onMount never runs.
			await reconcileSubscription(notificationsEnabled, cfg);
			const probed = cfg?.vapidPublicKey
				? await hasLiveDeviceSubscription(cfg.vapidPublicKey)
				: false;
			// Discard the probe if a handler has since written a fresher value — but
			// not if it left none. toggleMaster bumps the generation before its
			// first await and then has three exits that write nothing
			// (!vapidPublicKey, a failed subscribe, and the catch, which fires from
			// unsubscribe()'s unguarded getSubscription()). All three mutate no
			// subscription, so `probed` is still accurate; without the null arm
			// they'd pin deviceSubscribed at null for the life of the page, and a
			// null pins deviceGap to 'none' — suppressing the banner and the button
			// that fixes it on a device that genuinely can't receive.
			if (generation === deviceProbeGeneration || deviceSubscribed === null) {
				deviceSubscribed = probed;
			}
		} else {
			serverConfigured = false;
			deviceSubscribed = false;
		}
	});

	function subscribeErrorMessage(reason: (SubscribeResult & { ok: false })['reason']): string {
		return reason === 'permission_denied'
			? 'Permission denied.'
			: reason === 'unsupported'
				? 'This browser does not support push notifications.'
				: reason === 'no_registration'
					? 'Service worker not active yet. Reload and try again.'
					: 'Could not register the subscription with the server.';
	}

	async function patchPrefs(patch: Partial<UserPreferences>): Promise<UserPreferences | null> {
		const res = await fetch('/api/user/preferences', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch),
		});
		if (!res.ok) return null;
		return (await res.json()) as UserPreferences;
	}

	async function toggleMaster(next: boolean) {
		if (notifBusy) return;
		notifBusy = true;
		notifError = null;
		try {
			deviceProbeGeneration++;
			if (next) {
				if (!vapidPublicKey) {
					notifError = 'Server configuration missing — try reloading.';
					return;
				}
				const result = await subscribeToPush(vapidPublicKey);
				if (!result.ok) {
					notifError = subscribeErrorMessage(result.reason);
					permissionState = getPermissionState();
					return;
				}
				deviceSubscribed = await hasLiveDeviceSubscription(vapidPublicKey);
				const saved = await patchPrefs({ notificationsEnabled: true });
				if (!saved) {
					notifError = 'Subscription saved on this device but server update failed.';
					return;
				}
				notificationsEnabled = true;
				permissionState = getPermissionState();
			} else {
				await unsubscribeFromPush();
				deviceSubscribed = false;
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

	/**
	 * Subscribe THIS device while leaving the account pref alone — the banner's
	 * action. Same call as turning the master on (so it prompts for permission
	 * from inside a click handler, which iOS requires), minus the PATCH: the
	 * pref is already on, and that is the whole point of the banner.
	 */
	async function enableOnThisDevice() {
		if (notifBusy) return;
		notifBusy = true;
		notifError = null;
		deviceProbeGeneration++;
		try {
			if (!vapidPublicKey) {
				notifError = 'Server configuration missing — try reloading.';
				return;
			}
			const result = await subscribeToPush(vapidPublicKey);
			permissionState = getPermissionState();
			if (!result.ok) {
				notifError = subscribeErrorMessage(result.reason);
				return;
			}
			// Re-probe rather than trusting `ok`. `subscribe()` returns a
			// key-mismatched subscription as-is (it only re-POSTs what
			// getSubscription hands back), while the probe counts one as absent —
			// so on the rotated-key path an assumed `true` would clear the banner
			// and affirmatively claim "this device is subscribed" while nothing
			// was fixed. The probe is local (no network), so this costs nothing.
			deviceSubscribed = await hasLiveDeviceSubscription(vapidPublicKey);
			if (!deviceSubscribed) {
				notifError = 'Subscribed, but this device still has no usable subscription. Try again.';
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

<SettingsPage title="Preferences">
	<form
		onsubmit={(e) => e.preventDefault()}
		class="panel-card mx-auto flex max-w-2xl flex-col gap-6 p-4"
	>
		<section class="flex flex-col gap-3">
			<div>
				<h2 class="text-sm font-semibold">Personalization</h2>
				<p class="mt-0.5 text-xs text-fg-muted">
					Composed into a system prompt for new conversations (when not using a custom-model
					preset). Doesn't change existing chats — only future ones. Empty fields are omitted
					entirely.
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
				<p class="mt-0.5 text-xs text-fg-muted">How the message composer treats the Enter key.</p>
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
						<span class="text-fg-muted"> — Shift+Enter inserts a newline. (Default.) </span>
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
						<span class="text-fg-muted"> — Cmd/Ctrl+Enter sends. </span>
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
				<h2 class="text-sm font-semibold">Default features</h2>
				<p class="mt-0.5 text-xs text-fg-muted">
					Which capabilities a new conversation starts with. Every one of these stays switchable per
					conversation from the slider next to the composer — this only sets where each one starts.
				</p>
			</div>
			{#if visibleFeatureCategories.length > 0}
				{#each visibleFeatureCategories as cat (cat.id)}
					<label class="flex cursor-pointer items-start gap-2 text-sm">
						<input
							type="checkbox"
							checked={featureEnabledByDefault(cat.id)}
							onchange={(e) => void setFeatureDefault(cat.id, e.currentTarget.checked)}
							class="mt-0.5"
						/>
						<span>
							<span class="font-medium">{cat.label}</span>
							<span class="text-fg-muted">— {cat.description}</span>
						</span>
					</label>
				{/each}
			{:else}
				<p class="text-xs text-fg-muted">Loading available features…</p>
			{/if}
		</section>

		<div class="border-t border-border"></div>

		<section class="flex flex-col gap-2">
			<div>
				<h2 class="text-sm font-semibold">Context compaction</h2>
				<p class="mt-0.5 text-xs text-fg-muted">
					When a conversation fills up the model's context window, GlyphStream can summarize the
					older messages so the chat keeps going. The real messages stay in the thread (the summary
					is collapsed); only what's sent to the model is trimmed. You can always compact a
					conversation by hand from its header.
				</p>
			</div>
			<label class="flex cursor-pointer items-start gap-2 text-sm">
				<input
					type="checkbox"
					bind:checked={autoCompactionEnabled}
					onchange={() => void saveField({ autoCompactionEnabled })}
					class="mt-0.5"
				/>
				<span>
					<span class="font-medium">Compact automatically</span>
					<span class="text-fg-muted">
						— before your next message, if the conversation has crossed the threshold below. Only
						applies when the model's context window is known.
					</span>
				</span>
			</label>
			<div class={['flex items-center gap-2 text-sm', !autoCompactionEnabled && 'opacity-50']}>
				<label for="pref-compact-threshold">Compact at</label>
				<input
					id="pref-compact-threshold"
					type="number"
					min="1"
					max="100"
					step="5"
					bind:value={autoCompactionThreshold}
					disabled={!autoCompactionEnabled}
					onchange={() => void saveThreshold(autoCompactionThreshold)}
					class="w-20 rounded-md border border-border bg-surface-panel px-2 py-1 text-base shadow-sm focus:border-border-focus focus:outline-none disabled:opacity-50 sm:text-sm"
				/>
				<span class="text-fg-muted">% of the context window</span>
			</div>
		</section>

		<div class="border-t border-border"></div>

		<section class="flex flex-col gap-2">
			<div>
				<h2 class="text-sm font-semibold">Theme</h2>
				<p class="mt-0.5 text-xs text-fg-muted">
					Pick a visual style. Light vs dark within each follows your system setting. Applies
					instantly.
				</p>
			</div>
			<div class="grid grid-cols-3 gap-2">
				{#each THEMES as t (t.id)}
					<button
						type="button"
						onclick={() => selectTheme(t.id)}
						aria-pressed={theme === t.id}
						class="flex flex-col gap-1 rounded-lg border p-3 text-left transition {theme === t.id
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
				<p class="text-xs text-danger">{themeError}</p>
			{/if}
		</section>

		<div class="border-t border-border"></div>

		<section class="flex flex-col gap-3">
			<div>
				<h2 class="text-sm font-semibold">Notifications</h2>
				<p class="mt-0.5 text-xs text-fg-muted">
					Ping you when an assistant message finishes — toast when you're in the app on a different
					page, OS notification when you've switched apps or locked your phone. On iOS this needs
					the PWA installed to the Home Screen first.
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
						— receive push notifications on this device when a message completes.
					</span>
				</span>
			</label>

			{#if masterDisabledReason}
				<div class="rounded-md border px-3 py-2 text-xs alert-warning">
					{masterDisabledReason}
				</div>
			{:else if deviceGap !== 'none'}
				<div class="flex flex-col gap-2 rounded-md border px-3 py-2 text-xs alert-warning">
					<p>
						<span class="font-medium">This device isn't set up to receive notifications.</span>
						The setting above is saved to your account, but each device has to be enabled separately —
						{#if deviceGap === 'needs-permission'}
							and this one hasn't granted notification permission yet. Re-installing the app to your
							Home Screen resets that, so this is expected after adding it again.
						{:else}
							and this one's subscription has lapsed. Re-subscribing should restore it.
						{/if}
					</p>
					<button
						type="button"
						onclick={() => void enableOnThisDevice()}
						disabled={notifBusy}
						class="self-start rounded-md border border-current px-3 py-1.5 font-medium transition hover:bg-current/10 disabled:opacity-50"
					>
						{deviceGap === 'needs-permission'
							? 'Enable on this device'
							: 'Re-subscribe this device'}
					</button>
					<p class="opacity-80">
						Permission: <span class="font-mono">{permissionState}</span>
					</p>
				</div>
			{:else if pushSupported}
				<div class="text-xs text-fg-muted">
					Permission: <span class="font-mono">{permissionState}</span>
					{#if notificationsEnabled && deviceSubscribed}
						· this device is subscribed{/if}
				</div>
			{/if}

			<label
				class={[
					'flex cursor-pointer items-start gap-2 text-sm',
					!notificationsEnabled && 'opacity-50',
				]}
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
						— include a snippet of the assistant's reply in the notification body. Turn off if your
						threads are private to the device.
					</span>
				</span>
			</label>

			<label
				class={[
					'flex cursor-pointer items-start gap-2 text-sm',
					!notificationsEnabled && 'opacity-50',
				]}
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
						— pop a toast when a thread completes while you're on a different page. Turn off to only
						get OS-level notifications when the app is backgrounded.
					</span>
				</span>
			</label>

			{#if notifError}
				<div class="rounded-md border px-3 py-2 text-xs alert-danger">
					{notifError}
				</div>
			{/if}
		</section>

		{#if saveError}
			<div class="rounded-md border px-3 py-2 text-sm alert-danger">
				{saveError}
			</div>
		{/if}

		<!-- Auto-save confirmation flash. Fixed height so the row doesn't
			 jump when "Saved" appears/clears; no resting-state label since
			 the absence of a Save button already implies auto-save. -->
		<div class="flex h-5 items-center justify-end text-xs">
			{#if savedFlash}
				<span class="flex items-center gap-1 text-success">
					<Check size={14} strokeWidth={2.5} />
					Saved
				</span>
			{/if}
		</div>
	</form>
</SettingsPage>
