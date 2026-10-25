<!--
	Create / edit form for one scheduled task: what to ask, which model, when,
	and what it may do with tools. Saves through the API itself and tells the
	page when it's done.

	The tool section is the one that matters most: a run happens with nobody
	watching, so every MCP tool is explicitly Off (not offered), Ask (pauses the
	run and notifies you) or Allow (runs unasked). Tools the policy names on a
	server that isn't connected right now aren't listed, but are kept.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { errorMessageFromResponse } from '#lib/fetch-error.js';
	import { toast } from '#lib/toast.svelte.js';
	import { DAY_LABELS, EVERY_DAY, WEEKDAYS } from '#lib/schedule-format.js';
	import ModelPicker from '#lib/components/chat/ModelPicker.svelte';
	import { endpointIdOf } from '#lib/model-ids.js';
	import type {
		CustomModelSummary,
		FeatureCategory,
		ModelEntry,
		ScheduleCadence,
		ScheduledTask,
	} from '#lib/types/api.js';

	type ToolState = 'off' | 'ask' | 'allow';
	interface ServerOption {
		id: string;
		displayName: string;
		state: string;
		tools: Array<{ name: string; registeredName: string; description: string }>;
	}

	interface Props {
		/** The schedule being edited, or null to create one. */
		initial: ScheduledTask | null;
		/** Chat models only: a run is a chat turn. */
		models: ModelEntry[];
		customModels: CustomModelSummary[];
		/** Shown as the picker's Favorites group; starring stays in the chat picker. */
		favoriteModels: string[];
		/** Endpoints whose model list failed to load. A preset on one stays offered
		 *  even though its base model isn't in `models`. */
		unlistedEndpoints: string[];
		servers: ServerOption[];
		defaultTimezone: string | null;
		defaultDeadlineMinutes: number;
		minIntervalHours: number;
		onSaved: () => void | Promise<void>;
		onCancel: () => void;
	}

	let {
		initial,
		models,
		customModels,
		favoriteModels,
		unlistedEndpoints,
		servers,
		defaultTimezone,
		defaultDeadlineMinutes,
		minIntervalHours,
		onSaved,
		onCancel,
	}: Props = $props();

	/** Built-in features a run may use, as (category, label). Unchecked ones go
	 *  into the run's disabled features, as a chat's toggles do. */
	const FEATURES: Array<[FeatureCategory, string]> = [
		['web', 'Web access'],
		['personalization', 'Your persona and memories'],
		['code_interpreter', 'Code interpreter'],
		['canvas', 'Canvas'],
		['skills', 'Skills'],
	];
	/** Off for every run: reacting to an automated prompt is noise. */
	const ALWAYS_OFF: FeatureCategory[] = ['reactions'];

	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const timeZones = Intl.supportedValuesOf('timeZone');

	// Seeded ONCE from the props: the page remounts the form per schedule
	// (`{#key}`), so it never needs to follow a changing prop — and must not, or
	// a background refresh would wipe what's being typed.
	const start = untrack(() => ({
		seed: initial,
		minIntervalHours,
		defaultTimezone,
		defaultDeadlineMinutes,
	}));
	const seed = start.seed;
	let name = $state(seed?.name ?? '');
	let prompt = $state(seed?.prompt ?? '');
	// In the picker's shape: `endpointId::modelId`, or `custom::{id}` for a preset.
	let modelChoice = $state(
		seed?.customModelId ? `custom::${seed.customModelId}` : (seed?.modelId ?? ''),
	);
	let cadenceKind = $state<ScheduleCadence['kind']>(seed?.cadence.kind ?? 'daily');
	let time = $state(seed?.cadence.kind === 'daily' ? seed.cadence.time : '07:00');
	let days = $state<number[]>(
		seed?.cadence.kind === 'daily' ? [...seed.cadence.days] : [...WEEKDAYS],
	);
	let everyHours = $state(
		seed?.cadence.kind === 'interval'
			? seed.cadence.everyHours
			: Math.max(4, start.minIntervalHours),
	);
	let timezone = $state(seed?.timezone ?? start.defaultTimezone ?? browserZone);
	let deadlineMinutes = $state(seed?.deadlineMinutes ?? start.defaultDeadlineMinutes);
	let memoryWrites = $state(seed?.toolPolicy.memoryWrites ?? false);
	let enabledFeatures = $state<FeatureCategory[]>(
		FEATURES.map(([c]) => c).filter((c) => !(seed?.disabledFeatures ?? []).includes(c)),
	);
	let toolStates = $state<Record<string, ToolState>>(
		Object.fromEntries([
			...(seed?.toolPolicy.ask ?? []).map((n) => [n, 'ask'] as const),
			...(seed?.toolPolicy.allowed ?? []).map((n) => [n, 'allow'] as const),
		]),
	);
	let busy = $state(false);

	const listedTools = $derived(
		new Set(servers.flatMap((s) => s.tools.map((t) => t.registeredName))),
	);
	const unlistedKept = $derived(
		Object.entries(toolStates).filter(([n, st]) => st !== 'off' && !listedTools.has(n)).length,
	);
	const canSave = $derived(
		!busy &&
			name.trim().length > 0 &&
			prompt.trim().length > 0 &&
			modelChoice !== '' &&
			(cadenceKind === 'interval' || days.length > 0),
	);

	function toggleDay(d: number) {
		days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b);
	}

	function toggleFeature(c: FeatureCategory) {
		enabledFeatures = enabledFeatures.includes(c)
			? enabledFeatures.filter((x) => x !== c)
			: [...enabledFeatures, c];
	}

	function setTool(registeredName: string, state: ToolState) {
		toolStates = { ...toolStates, [registeredName]: state };
	}

	function setServer(server: ServerOption, state: ToolState) {
		const next = { ...toolStates };
		for (const t of server.tools) next[t.registeredName] = state;
		toolStates = next;
	}

	function cadence(): ScheduleCadence {
		if (cadenceKind === 'daily') return { kind: 'daily', time, days };
		// Keep an existing interval's grid; a new one starts at the next full hour.
		const anchorAt =
			seed?.cadence.kind === 'interval'
				? seed.cadence.anchorAt
				: Math.ceil(Date.now() / 3_600_000) * 3_600_000;
		return { kind: 'interval', everyHours, anchorAt };
	}

	async function save() {
		if (!canSave) return;
		busy = true;
		const custom = modelChoice.startsWith('custom::') ? modelChoice.slice('custom::'.length) : null;
		const entries = Object.entries(toolStates);
		const payload = {
			name: name.trim(),
			prompt: prompt.trim(),
			...(custom ? { customModelId: custom } : { modelId: modelChoice }),
			cadence: cadence(),
			timezone,
			deadlineMinutes,
			enabled: seed?.enabled ?? true,
			toolPolicy: {
				allowed: entries.filter(([, s]) => s === 'allow').map(([n]) => n),
				ask: entries.filter(([, s]) => s === 'ask').map(([n]) => n),
				memoryWrites,
			},
			disabledFeatures: [
				...FEATURES.map(([c]) => c).filter((c) => !enabledFeatures.includes(c)),
				...ALWAYS_OFF,
			],
		};
		try {
			const res = await fetch(
				seed ? `/api/user/schedules/${encodeURIComponent(seed.id)}` : '/api/user/schedules',
				{
					method: seed ? 'PUT' : 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				},
			);
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			await onSaved();
		} catch (e) {
			toast.error(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = false;
		}
	}

	const inputClass =
		'w-full rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm outline-none focus:border-accent';
	const chipClass = (on: boolean) =>
		`rounded-md border px-2.5 py-1 text-xs transition ${on ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted hover:bg-surface-sunken'}`;
</script>

<div class="flex flex-col gap-4">
	<label class="flex flex-col gap-1">
		<span class="text-xs text-fg-muted">Name</span>
		<input bind:value={name} maxlength="100" placeholder="Morning brief" class={inputClass} />
	</label>

	<label class="flex flex-col gap-1">
		<span class="text-xs text-fg-muted">What to ask</span>
		<textarea
			bind:value={prompt}
			rows="5"
			placeholder="Search my inbox for anything from the last day that needs a reply, and summarize it."
			class="{inputClass} resize-y"></textarea>
	</label>

	<div class="flex flex-col gap-1">
		<span class="text-xs text-fg-muted">Model</span>
		<ModelPicker
			{models}
			{customModels}
			filterKinds={['chat']}
			favoritedIds={favoriteModels}
			baseIsGone={(id: string) => !unlistedEndpoints.includes(endpointIdOf(id) ?? '')}
			bind:value={modelChoice}
			disabled={busy}
		/>
		{#if modelChoice.startsWith('custom::')}
			<span class="text-xs text-fg-muted">
				The custom model's prompt and settings are copied in when you save.
			</span>
		{/if}
	</div>

	<fieldset class="flex flex-col gap-2">
		<legend class="mb-1 text-xs text-fg-muted">When</legend>
		<div class="flex gap-1.5">
			<button
				type="button"
				aria-pressed={cadenceKind === 'daily'}
				class={chipClass(cadenceKind === 'daily')}
				onclick={() => (cadenceKind = 'daily')}>At a time of day</button
			>
			<button
				type="button"
				aria-pressed={cadenceKind === 'interval'}
				class={chipClass(cadenceKind === 'interval')}
				onclick={() => (cadenceKind = 'interval')}>Every few hours</button
			>
		</div>
		{#if cadenceKind === 'daily'}
			<div class="flex flex-wrap items-center gap-2">
				<input
					type="time"
					bind:value={time}
					aria-label="Time of day"
					class="rounded-md border border-border bg-surface-sunken px-2 py-1 text-sm"
				/>
				<div class="flex flex-wrap gap-1" role="group" aria-label="Days">
					{#each DAY_LABELS as label, d (d)}
						<button
							type="button"
							aria-pressed={days.includes(d)}
							class={chipClass(days.includes(d))}
							onclick={() => toggleDay(d)}>{label}</button
						>
					{/each}
				</div>
				<button
					type="button"
					class="text-xs text-fg-muted underline"
					onclick={() => (days = [...WEEKDAYS])}>Weekdays</button
				>
				<button
					type="button"
					class="text-xs text-fg-muted underline"
					onclick={() => (days = [...EVERY_DAY])}>Every day</button
				>
			</div>
		{:else}
			<label class="flex items-center gap-2 text-sm">
				Every
				<input
					type="number"
					bind:value={everyHours}
					min={minIntervalHours}
					max="168"
					class="w-20 rounded-md border border-border bg-surface-sunken px-2 py-1 text-sm"
				/>
				hours
			</label>
		{/if}
		<label class="flex flex-col gap-1">
			<span class="text-xs text-fg-muted">Time zone</span>
			<input bind:value={timezone} list="schedule-time-zones" class={inputClass} />
			<datalist id="schedule-time-zones">
				{#each timeZones as tz (tz)}
					<option value={tz}></option>
				{/each}
			</datalist>
		</label>
		<label class="flex items-center gap-2 text-sm">
			Skip a run that can't start within
			<input
				type="number"
				bind:value={deadlineMinutes}
				min="5"
				max="1440"
				class="w-20 rounded-md border border-border bg-surface-sunken px-2 py-1 text-sm"
			/>
			minutes
		</label>
		<span class="text-xs text-fg-muted">
			Runs wait behind anyone chatting, and start up to three minutes after their time.
		</span>
	</fieldset>

	<fieldset class="flex flex-col gap-2">
		<legend class="mb-1 text-xs text-fg-muted">Built-in features</legend>
		<div class="flex flex-wrap gap-2">
			{#each FEATURES as [category, label] (category)}
				<label
					class="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs transition hover:bg-surface-sunken"
				>
					<input
						type="checkbox"
						checked={enabledFeatures.includes(category)}
						onchange={() => toggleFeature(category)}
					/>
					{label}
				</label>
			{/each}
		</div>
		<label class="flex cursor-pointer items-center gap-1.5 text-xs">
			<input type="checkbox" bind:checked={memoryWrites} />
			Let runs save to your memories
		</label>
	</fieldset>

	<fieldset class="flex flex-col gap-2">
		<legend class="mb-1 text-xs text-fg-muted">MCP tools</legend>
		<p class="text-xs text-fg-muted">
			<strong>Off</strong> tools aren't offered. <strong>Ask</strong> pauses the run and notifies
			you. <strong>Allow</strong> runs without asking — only for tools you'd trust with nobody watching.
		</p>
		{#if servers.length === 0}
			<p class="text-xs text-fg-muted">No MCP servers are configured.</p>
		{/if}
		{#each servers as server (server.id)}
			<div class="rounded-md border border-border p-2">
				<div class="mb-1 flex flex-wrap items-center gap-2">
					<span class="text-sm font-medium">{server.displayName}</span>
					{#if server.state === 'needs-credential'}
						<span class="text-[10px] text-warning">needs your token</span>
					{:else if server.state === 'failed'}
						<span class="text-[10px] text-danger">unreachable</span>
					{/if}
					{#if server.tools.length > 0}
						<span class="ml-auto flex gap-1 text-[10px] text-fg-muted">
							All:
							{#each ['off', 'ask', 'allow'] as const as st (st)}
								<button type="button" class="underline" onclick={() => setServer(server, st)}
									>{st}</button
								>
							{/each}
						</span>
					{/if}
				</div>
				{#if server.tools.length === 0}
					<p class="text-xs text-fg-muted">No tools available right now.</p>
				{/if}
				<ul class="flex flex-col gap-1">
					{#each server.tools as tool (tool.registeredName)}
						{@const current = toolStates[tool.registeredName] ?? 'off'}
						<li class="flex items-center gap-2">
							<span class="min-w-0 flex-1 truncate font-mono text-xs" title={tool.description}
								>{tool.name}</span
							>
							<span class="flex shrink-0 gap-0.5" role="radiogroup" aria-label="{tool.name} access">
								{#each ['off', 'ask', 'allow'] as const as st (st)}
									<button
										type="button"
										role="radio"
										aria-checked={current === st}
										class="rounded px-2 py-0.5 text-[11px] transition {current === st
											? st === 'allow'
												? 'bg-success/15 text-success'
												: st === 'ask'
													? 'bg-warning/15 text-warning'
													: 'bg-surface-sunken text-fg'
											: 'text-fg-muted hover:bg-surface-sunken'}"
										onclick={() => setTool(tool.registeredName, st)}
									>
										{st === 'off' ? 'Off' : st === 'ask' ? 'Ask' : 'Allow'}
									</button>
								{/each}
							</span>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
		{#if unlistedKept > 0}
			<p class="text-xs text-fg-muted">
				{unlistedKept} tool{unlistedKept === 1 ? '' : 's'} from servers not connected right now
				{unlistedKept === 1 ? 'is' : 'are'} kept as set.
			</p>
		{/if}
	</fieldset>

	<div class="flex gap-2">
		<button
			type="button"
			disabled={!canSave}
			onclick={save}
			class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-50"
		>
			{seed ? 'Save changes' : 'Create schedule'}
		</button>
		<button
			type="button"
			onclick={onCancel}
			class="rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-surface-sunken"
		>
			Cancel
		</button>
	</div>
</div>
