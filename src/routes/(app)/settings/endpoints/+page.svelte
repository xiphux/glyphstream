<!--
	Read-only endpoint health + activity view (admin only).

	Answers the operator questions that `config.toml` can't: is each endpoint
	reachable, how many models does it advertise, is it generating right now and
	with what, and how deep is the line behind it.

	GROUPS are the outer structure because the concurrency gate is keyed by
	`resource_group`, not by endpoint. An endpoint that never opted into a group
	is its own group of one and renders as a plain card; a shared-GPU pair
	renders as one bordered group with one cap, one queue and one resident-model
	marker — which is the only framing in which "active 1 / 1" on an endpoint
	that isn't generating makes sense.

	Two clocks, deliberately separate. The 3s POLL replaces the whole snapshot;
	the 1s TICK only advances `nowMs` so elapsed timers move between polls
	instead of jumping in 3s steps. Both stop while the tab is hidden — a
	backgrounded diagnostic page has nobody to inform, and this one is likely to
	be left open for a long time.
-->
<script lang="ts">
	import SettingsPage from '$lib/components/settings/SettingsPage.svelte';
	import {
		CircleAlert,
		CircleCheck,
		CircleHelp,
		CircleSlash,
		Loader2,
		RefreshCw,
	} from '@lucide/svelte';
	import { toast } from '$lib/toast.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import type {
		EndpointGroupStatus,
		EndpointHealth,
		EndpointSlotInfo,
		EndpointSlotPurpose,
		EndpointStatus,
		EndpointsStatusResponse,
	} from '$lib/types/api';

	let { data }: { data: { status: EndpointsStatusResponse } } = $props();

	// SSR gives the first paint; from there the poll owns this, so seeding from
	// `data` once is the intent — the load never re-runs behind us.
	// svelte-ignore state_referenced_locally
	let status = $state<EndpointsStatusResponse>(data.status);
	let rechecking = $state<string | null>(null);

	// Ticks once a second so elapsed times advance between the 3s polls.
	let nowMs = $state(Date.now());

	// The browser's clock minus the server's, measured on every snapshot. An
	// elapsed time computed from a raw `Date.now() - since` across two machines
	// can render as negative, which reads as a bug in the page rather than in
	// the clocks — so every duration goes through `elapsed()`, which subtracts
	// this back out.
	// svelte-ignore state_referenced_locally
	let skewMs = $state(Date.now() - data.status.now);

	function applySnapshot(next: EndpointsStatusResponse) {
		status = next;
		skewMs = Date.now() - next.now;
	}

	async function poll() {
		try {
			const res = await fetch('/api/admin/endpoints/status');
			if (!res.ok) return; // Transient; the next tick tries again.
			applySnapshot((await res.json()) as EndpointsStatusResponse);
		} catch {
			// Offline / navigating away. Keep the last snapshot on screen rather
			// than blanking a diagnostic page on one failed poll.
		}
	}

	$effect(() => {
		// One interval pair for the life of the page. `document.hidden` is checked
		// at fire time rather than by tearing the timers down on visibilitychange:
		// same effect, and it can't leave a listener behind.
		const pollTimer = setInterval(() => {
			if (!document.hidden) void poll();
		}, 3000);
		const tickTimer = setInterval(() => {
			if (!document.hidden) nowMs = Date.now();
		}, 1000);
		// A tab returning to the foreground has a snapshot as stale as it was
		// away; refresh immediately rather than showing it for up to 3s more.
		const onVisible = () => {
			if (!document.hidden) {
				nowMs = Date.now();
				void poll();
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(pollTimer);
			clearInterval(tickTimer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	async function recheck(endpointId: string) {
		if (rechecking) return;
		rechecking = endpointId;
		try {
			const res = await fetch(`/api/admin/endpoints/${encodeURIComponent(endpointId)}/recheck`, {
				method: 'POST',
			});
			if (!res.ok) {
				toast.error(await errorMessageFromResponse(res));
				return;
			}
			applySnapshot((await res.json()) as EndpointsStatusResponse);
		} finally {
			rechecking = null;
		}
	}

	/** Seconds since a server-stamped instant, floored at zero. */
	function elapsed(since: number): number {
		return Math.max(0, Math.round((nowMs - skewMs - since) / 1000));
	}

	function duration(seconds: number): string {
		if (seconds < 60) return `${seconds}s`;
		const m = Math.floor(seconds / 60);
		if (m < 60) return `${m}m ${seconds % 60}s`;
		return `${Math.floor(m / 60)}h ${m % 60}m`;
	}

	function ago(at: number | null): string {
		if (at === null) return 'never';
		return `${duration(elapsed(at))} ago`;
	}

	function healthLabel(h: EndpointHealth): string {
		switch (h) {
			case 'ok':
				return 'Reachable';
			case 'degraded':
				return 'Degraded';
			case 'down':
				return 'Unreachable';
			case 'unknown':
				return 'Not yet checked';
		}
	}

	function healthClass(h: EndpointHealth): string {
		switch (h) {
			case 'ok':
				return 'text-success';
			case 'degraded':
				return 'text-warning';
			case 'down':
				return 'text-danger';
			case 'unknown':
				return 'text-fg-muted';
		}
	}

	function purposeLabel(p: EndpointSlotPurpose): string {
		switch (p) {
			case 'chat':
				return 'Chat';
			case 'image':
				return 'Image';
			case 'video':
				return 'Video';
			case 'enhance':
				return 'Prompt enhance';
			case 'title':
				return 'Title';
			case 'compaction':
				return 'Compaction';
			case 'memory':
				return 'Memory';
			case 'dream':
				return 'Dreaming';
			case 'other':
				return 'Other';
		}
	}

	/** Model counts worth naming, in a stable order. Kinds with none are dropped
	 *  — "0 video" on a chat-only endpoint is noise, not information. */
	function kindBreakdown(ep: EndpointStatus): string {
		const order = ['chat', 'image', 'video', 'embedding'] as const;
		return order
			.filter((k) => ep.modelsByKind[k] > 0)
			.map((k) => `${ep.modelsByKind[k]} ${k}`)
			.join(' · ');
	}

	/** A group is only worth drawing as a group when it actually has members
	 *  sharing a gate; the default one-endpoint-per-group case renders flat. */
	function isSharedGroup(g: EndpointGroupStatus): boolean {
		return g.endpoints.length > 1;
	}

	function capLabel(max: number | null): string {
		return max === null ? '∞' : String(max);
	}

	function slotKey(s: EndpointSlotInfo): string {
		return `${s.endpointId}:${s.purpose}:${s.modelId ?? ''}:${s.since}`;
	}
</script>

<SettingsPage title="Endpoints">
	{#snippet description()}
		Health and live activity for the endpoints in <code class="font-mono">config.toml</code>.
		Read-only — endpoints are configured in that file and picked up on restart.
	{/snippet}

	<div class="mx-auto flex max-w-2xl flex-col gap-3">
		{#if status.configError}
			<div class="rounded-md border px-3 py-2 text-xs alert-danger">
				<div class="font-medium">config.toml failed to load</div>
				<div class="mt-1 break-words">{status.configError}</div>
			</div>
		{:else if status.groups.length === 0}
			<div class="panel-card p-6 text-center text-sm text-fg-muted">
				<p>No endpoints configured.</p>
				<p class="mt-2 text-xs">
					Add <code class="font-mono">[[endpoints]]</code> blocks to your
					<code class="font-mono">config.toml</code> to point GlyphStream at a backend.
				</p>
			</div>
		{:else}
			{#each status.groups as group (group.resourceGroup)}
				{#if isSharedGroup(group)}
					<!-- A shared resource_group: one gate, one queue, drawn as one unit so
					     an endpoint sitting at capacity while idle makes sense. -->
					<section class="rounded-lg border border-dashed border-border p-3">
						<header class="mb-2 flex flex-wrap items-baseline justify-between gap-2 px-1">
							<div class="text-xs font-medium uppercase tracking-wide text-fg-muted">
								Shared resource · <span class="font-mono normal-case">{group.resourceGroup}</span>
							</div>
							<div class="text-xs text-fg-muted">
								{group.active}/{capLabel(group.maxConcurrent)} slots{group.waiting > 0
									? ` · ${group.waiting} queued`
									: ''}
							</div>
						</header>
						{#if group.evicting}
							<div
								class="mb-2 flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs alert-warning"
							>
								<Loader2 size={13} strokeWidth={2.25} class="animate-spin" aria-hidden="true" />
								<span>Freeing GPU memory for a handover…</span>
							</div>
						{/if}
						<div class="flex flex-col gap-2">
							{#each group.endpoints as ep (ep.id)}
								{@render endpointCard(ep, group)}
							{/each}
						</div>
					</section>
				{:else}
					{@render endpointCard(group.endpoints[0], group)}
				{/if}
			{/each}
		{/if}
	</div>
</SettingsPage>

{#snippet endpointCard(ep: EndpointStatus, group: EndpointGroupStatus)}
	<section class="panel-card p-4">
		<header class="flex items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="truncate text-base font-medium">{ep.displayName}</h2>
				<p class="mt-0.5 truncate text-xs text-fg-muted">
					<span class="font-mono">{ep.id}</span>
					<span class="mx-1">·</span>
					<span class="font-mono">{ep.baseUrl}</span>
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<div class="flex items-center gap-1.5 text-xs {healthClass(ep.health)}">
					{#if ep.health === 'ok'}
						<CircleCheck size={14} strokeWidth={2.25} aria-hidden="true" />
					{:else if ep.health === 'degraded'}
						<CircleAlert size={14} strokeWidth={2.25} aria-hidden="true" />
					{:else if ep.health === 'down'}
						<CircleSlash size={14} strokeWidth={2.25} aria-hidden="true" />
					{:else}
						<CircleHelp size={14} strokeWidth={2.25} aria-hidden="true" />
					{/if}
					<span>{healthLabel(ep.health)}</span>
				</div>
				<button
					type="button"
					onclick={() => void recheck(ep.id)}
					disabled={rechecking !== null}
					title="Re-probe this endpoint now"
					class="rounded-md border border-border p-1.5 transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
					aria-label="Recheck {ep.displayName}"
				>
					<RefreshCw
						size={13}
						strokeWidth={2.25}
						class={rechecking === ep.id ? 'animate-spin' : ''}
						aria-hidden="true"
					/>
				</button>
			</div>
		</header>

		{#if ep.error}
			<div
				class="mt-3 rounded-md border px-3 py-2 text-xs {ep.health === 'degraded'
					? 'alert-warning'
					: 'alert-danger'}"
			>
				<div class="break-words">{ep.error}</div>
				{#if ep.health === 'degraded'}
					<div class="mt-1 opacity-80">
						Showing the {ep.modelCount} model{ep.modelCount === 1 ? '' : 's'} from the last successful
						check — generations may still work.
					</div>
				{/if}
			</div>
		{/if}

		<!-- Models + occupancy, the two numbers the page exists for. -->
		<dl class="mt-3 grid grid-cols-3 gap-2 text-xs">
			<div class="rounded-md border border-border bg-surface-sunken/40 p-2">
				<dt class="text-fg-muted">Models</dt>
				<dd class="mt-0.5 text-sm font-medium">{ep.modelCount}</dd>
				{#if kindBreakdown(ep)}
					<dd class="mt-0.5 text-[11px] text-fg-muted">{kindBreakdown(ep)}</dd>
				{/if}
			</div>
			<div class="rounded-md border border-border bg-surface-sunken/40 p-2">
				<dt class="text-fg-muted">Generating</dt>
				<dd class="mt-0.5 text-sm font-medium">{ep.active.length}</dd>
				<dd class="mt-0.5 text-[11px] text-fg-muted">
					{isSharedGroup(group)
						? `group ${group.active}/${capLabel(group.maxConcurrent)}`
						: `of ${capLabel(group.maxConcurrent)}`}
				</dd>
			</div>
			<div class="rounded-md border border-border bg-surface-sunken/40 p-2">
				<dt class="text-fg-muted">Queued</dt>
				<dd class="mt-0.5 text-sm font-medium">{ep.queued.length}</dd>
				{#if isSharedGroup(group) && group.waiting !== ep.queued.length}
					<dd class="mt-0.5 text-[11px] text-fg-muted">{group.waiting} in group</dd>
				{/if}
			</div>
		</dl>

		{#if ep.active.length > 0 || ep.queued.length > 0}
			<ul class="mt-2 flex flex-col gap-1.5">
				{#each ep.active as slot (slotKey(slot))}
					<li
						class="flex items-center gap-2 rounded-md border border-border bg-surface-sunken/40 p-2 text-xs"
					>
						{#if slot.state === 'releasing'}
							<Loader2
								size={13}
								strokeWidth={2.25}
								class="shrink-0 animate-spin text-warning"
								aria-hidden="true"
							/>
						{:else}
							<span class="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true"></span>
						{/if}
						<span class="shrink-0 font-medium">{purposeLabel(slot.purpose)}</span>
						{#if slot.modelId}
							<span class="min-w-0 flex-1 truncate font-mono text-fg-muted">{slot.modelId}</span>
						{:else}
							<span class="min-w-0 flex-1"></span>
						{/if}
						<span class="shrink-0 tabular-nums text-fg-muted">
							{slot.state === 'releasing' ? 'freeing memory' : duration(elapsed(slot.since))}
						</span>
					</li>
				{/each}
				{#each ep.queued as slot (slotKey(slot))}
					<li
						class="flex items-center gap-2 rounded-md border border-dashed border-border p-2 text-xs opacity-70"
					>
						<span class="size-1.5 shrink-0 rounded-full bg-fg-muted" aria-hidden="true"></span>
						<span class="shrink-0 font-medium">{purposeLabel(slot.purpose)}</span>
						{#if slot.modelId}
							<span class="min-w-0 flex-1 truncate font-mono text-fg-muted">{slot.modelId}</span>
						{:else}
							<span class="min-w-0 flex-1"></span>
						{/if}
						<span class="shrink-0 tabular-nums text-fg-muted">
							waiting {duration(elapsed(slot.since))}
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-2 text-xs text-fg-muted">Idle.</p>
		{/if}

		<!-- Config, for the "why is it behaving like that" follow-up. -->
		<div class="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-muted">
			<span>max_concurrent {capLabel(ep.maxConcurrent)}</span>
			<span>timeout {ep.requestTimeoutSeconds}s</span>
			{#if ep.providerQuirk !== 'passthrough'}<span>quirk {ep.providerQuirk}</span>{/if}
			{#if ep.contextWindow}<span>ctx {ep.contextWindow.toLocaleString()}</span>{/if}
			{#if ep.supportsTools}<span>tools</span>{/if}
			<span>{ep.hasApiKey ? 'api key set' : 'no api key'}</span>
			{#if ep.releaseStrategy}
				<span>release {ep.releaseStrategy}</span>
			{/if}
			{#if isSharedGroup(group) && group.lastHolderId === ep.id}
				<span class="text-warning">model presumed resident</span>
			{/if}
			<span class="ml-auto">
				checked {ago(ep.checkedAt)}{ep.latencyMs !== null ? ` · ${ep.latencyMs}ms` : ''}
			</span>
		</div>
	</section>
{/snippet}
