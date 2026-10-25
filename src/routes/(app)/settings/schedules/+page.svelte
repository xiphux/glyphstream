<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { CalendarClock, History, Pencil, Play, Plus, Trash2, X } from '@lucide/svelte';
	import SettingsPage from '#lib/components/settings/SettingsPage.svelte';
	import ScheduleEditor from '#lib/components/settings/ScheduleEditor.svelte';
	import { confirmDialog } from '#lib/confirm.svelte.js';
	import { errorMessageFromResponse } from '#lib/fetch-error.js';
	import { describeCadence, describeRun } from '#lib/schedule-format.js';
	import { toast } from '#lib/toast.svelte.js';
	import type {
		ScheduledRun,
		ScheduledRunsResponse,
		ScheduledTaskSummary,
	} from '#lib/types/api.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** null: editor closed; '': creating; otherwise the id being edited. */
	let editing = $state<string | null>(null);
	let busyId = $state<string | null>(null);
	/** Schedule id → its loaded history, for the rows whose history is open. */
	let history = $state<Record<string, ScheduledRun[]>>({});

	const editingSchedule = $derived(
		editing ? (data.schedules.find((s) => s.id === editing) ?? null) : null,
	);

	const refresh = () => invalidate('settings:schedules');

	function when(ms: number | null, timeZone: string): string {
		if (ms === null) return '—';
		return new Intl.DateTimeFormat(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			timeZone,
		}).format(ms);
	}

	const toneClass = {
		ok: 'text-success',
		warn: 'text-warning',
		bad: 'text-danger',
		muted: 'text-fg-muted',
	} as const;

	async function call(id: string, input: RequestInfo, init: RequestInit, verb: string) {
		if (busyId) return false;
		busyId = id;
		try {
			const res = await fetch(input, init);
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			await refresh();
			if (history[id]) await loadHistory(id);
			return true;
		} catch (e) {
			toast.error(`Couldn't ${verb}: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		} finally {
			busyId = null;
		}
	}

	function setEnabled(s: ScheduledTaskSummary, enabled: boolean) {
		return call(
			s.id,
			`/api/user/schedules/${encodeURIComponent(s.id)}`,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled }),
			},
			enabled ? 'turn it on' : 'turn it off',
		);
	}

	async function runNow(s: ScheduledTaskSummary) {
		const ok = await call(
			s.id,
			`/api/user/schedules/${encodeURIComponent(s.id)}/run`,
			{ method: 'POST' },
			'start a run',
		);
		if (!ok) return;
		toast.success(`"${s.name}" is running — you'll be notified when it's done.`);
		// The run's conversation exists by the time the request returns; show it
		// in the sidebar now rather than on the next refresh.
		await invalidate('app:conversations');
	}

	async function remove(s: ScheduledTaskSummary) {
		const ok = await confirmDialog.ask({
			title: `Delete "${s.name}"?`,
			message: 'It stops running. Conversations from its past runs are kept.',
			confirmLabel: 'Delete',
		});
		if (!ok) return;
		await call(
			s.id,
			`/api/user/schedules/${encodeURIComponent(s.id)}`,
			{ method: 'DELETE' },
			'delete it',
		);
	}

	async function loadHistory(id: string) {
		const res = await fetch(`/api/user/schedules/${encodeURIComponent(id)}/runs`);
		if (!res.ok) {
			toast.error(`Couldn't load the history: ${await errorMessageFromResponse(res)}`);
			return;
		}
		history = { ...history, [id]: ((await res.json()) as ScheduledRunsResponse).runs };
	}

	function toggleHistory(id: string) {
		if (history[id]) {
			const next = { ...history };
			delete next[id];
			history = next;
		} else {
			void loadHistory(id);
		}
	}

	async function saved() {
		editing = null;
		await refresh();
	}
</script>

<SettingsPage title="Scheduled tasks">
	{#snippet description()}
		Prompts that run on their own — a morning brief, a daily inbox summary. Each run is a new
		conversation, marked with a clock in the sidebar, and you get a notification when it finishes,
		needs your approval, or fails.
	{/snippet}

	<div class="mx-auto flex max-w-2xl flex-col gap-4">
		<section class="panel-card p-4">
			<div class="flex items-center justify-between {editing === null ? '' : 'mb-3'}">
				<h2 class="text-sm font-medium">
					{editing === null ? 'Your schedules' : editing ? 'Edit schedule' : 'New schedule'}
				</h2>
				{#if editing === null}
					<button
						type="button"
						onclick={() => (editing = '')}
						class="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:opacity-90"
					>
						<Plus size={14} strokeWidth={2.25} /> New schedule
					</button>
				{:else}
					<button
						type="button"
						onclick={() => (editing = null)}
						aria-label="Close editor"
						class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken"
					>
						<X size={14} strokeWidth={2.25} />
					</button>
				{/if}
			</div>

			{#if editing !== null}
				{#key editing}
					<ScheduleEditor
						initial={editingSchedule}
						models={data.models}
						customModels={data.customModels}
						favoriteModels={data.favoriteModels}
						servers={data.servers}
						defaultTimezone={data.defaultTimezone}
						defaultDeadlineMinutes={data.defaultDeadlineMinutes}
						minIntervalHours={data.minIntervalHours}
						onSaved={saved}
						onCancel={() => (editing = null)}
					/>
				{/key}
			{:else if data.schedules.length === 0}
				<p class="py-8 text-center text-sm text-fg-muted">
					No schedules yet. Create one to have a prompt run on its own.
				</p>
			{/if}
		</section>

		{#if editing === null && data.schedules.length > 0}
			<section class="panel-card p-2">
				<ul class="flex flex-col gap-0.5">
					{#each data.schedules as s (s.id)}
						{@const last = s.lastRun ? describeRun(s.lastRun) : null}
						<li class="rounded-md px-3 py-2.5 transition hover:bg-surface-sunken/70">
							<div class="flex items-start gap-3">
								<CalendarClock
									size={16}
									strokeWidth={2.25}
									class="mt-0.5 shrink-0 {s.enabled ? 'text-accent' : 'text-fg-muted'}"
									aria-hidden="true"
								/>
								<div class="min-w-0 flex-1 text-sm">
									<div class="font-medium">{s.name}</div>
									<div class="text-xs text-fg-muted">
										{describeCadence(s.cadence)}
										<span class="opacity-70">· {s.timezone}</span>
									</div>
									<div class="mt-0.5 text-xs text-fg-muted">
										{#if s.enabled}
											Next: {when(s.nextRunAt, s.timezone)}
										{:else}
											Off{s.disabledReason ? ` — ${s.disabledReason}` : ''}
										{/if}
									</div>
									{#if s.lastRun && last}
										<div class="mt-0.5 text-xs">
											<span class="text-fg-muted">Last:</span>
											{#if s.lastRun.conversationId}
												<a
													href={resolve(`chat/${s.lastRun.conversationId}`)}
													class="{toneClass[last.tone]} underline-offset-2 hover:underline"
													>{last.label}</a
												>
											{:else}
												<span class={toneClass[last.tone]}>{last.label}</span>
											{/if}
										</div>
									{/if}
								</div>
								<div class="flex shrink-0 items-center gap-1">
									<label class="mr-1 flex cursor-pointer items-center gap-1 text-xs text-fg-muted">
										<input
											type="checkbox"
											checked={s.enabled}
											disabled={busyId === s.id}
											onchange={(e) => setEnabled(s, e.currentTarget.checked)}
										/>
										On
									</label>
									<button
										type="button"
										disabled={busyId === s.id}
										onclick={() => runNow(s)}
										title="Run now"
										aria-label="Run {s.name} now"
										class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken disabled:opacity-50"
									>
										<Play size={14} strokeWidth={2.25} />
									</button>
									<button
										type="button"
										onclick={() => toggleHistory(s.id)}
										title="Run history"
										aria-label="Run history for {s.name}"
										aria-expanded={!!history[s.id]}
										class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken"
									>
										<History size={14} strokeWidth={2.25} />
									</button>
									<button
										type="button"
										disabled={busyId === s.id}
										onclick={() => (editing = s.id)}
										title="Edit"
										aria-label="Edit {s.name}"
										class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken disabled:opacity-50"
									>
										<Pencil size={14} strokeWidth={2.25} />
									</button>
									<button
										type="button"
										disabled={busyId === s.id}
										onclick={() => remove(s)}
										title="Delete"
										aria-label="Delete {s.name}"
										class="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-fg-muted transition hover:bg-surface-sunken hover:text-danger disabled:opacity-50"
									>
										<Trash2 size={14} strokeWidth={2.25} />
									</button>
								</div>
							</div>
							{#if history[s.id]}
								<ul class="mt-2 ml-7 flex flex-col gap-0.5 border-l border-border pl-3">
									{#each history[s.id] as run (run.id)}
										{@const r = describeRun(run)}
										<li class="flex gap-2 text-xs">
											<span class="shrink-0 text-fg-muted">{when(run.slotAt, s.timezone)}</span>
											{#if run.trigger === 'manual'}
												<span class="shrink-0 text-fg-muted">(Run now)</span>
											{/if}
											{#if run.conversationId}
												<a
													href={resolve(`chat/${run.conversationId}`)}
													class="min-w-0 truncate {toneClass[
														r.tone
													]} underline-offset-2 hover:underline">{r.label}</a
												>
											{:else}
												<span class="min-w-0 truncate {toneClass[r.tone]}">{r.label}</span>
											{/if}
										</li>
									{:else}
										<li class="text-xs text-fg-muted">No runs yet.</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</SettingsPage>
