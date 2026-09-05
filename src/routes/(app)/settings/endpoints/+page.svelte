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
	import { SvelteSet } from 'svelte/reactivity';
	import { toast } from '$lib/toast.svelte';
	import { errorMessageFromResponse } from '$lib/fetch-error';
	import type { PageData } from './$types';
	import type {
		EndpointGroupStatus,
		EndpointHealth,
		EndpointSlotPurpose,
		EndpointStatus,
		EndpointsStatusResponse,
	} from '$lib/types/api';

	let { data }: { data: PageData } = $props();

	// SSR gives the first paint; from there the poll owns this, so reading `data`
	// exactly once is the intent.
	//
	// The load DOES re-run behind us — `+page.server.ts` awaits `parent()`, which
	// couples it to the `(app)` layout's `invalidate('app:conversations')`, and
	// the layout fires that on refocus, which this page (left open for long
	// stretches, by design) will see often. Seeding non-reactively is what makes
	// that harmless: a reload replaces `data` and nothing here reads it again, so
	// the poll stays the single source of truth instead of fighting a stale SSR
	// snapshot for the display.
	// `.raw` because nothing ever writes an element in place: the whole snapshot
	// is replaced by `applySnapshot` and read-only everywhere else (`configError`
	// and `groups` in the template, nothing else). CLAUDE.md's rule is to grep the
	// CONSUMERS before converting, not just this module — done, and there are no
	// consumers outside this file, since a page component is nobody's import. If
	// that ever changes, an element-level write here would signal nothing and this
	// has to go back to deep `$state`. Skipping the proxy matters because the poll
	// discards and rebuilds this whole tree every three seconds, for as long as
	// the tab is open.
	// svelte-ignore state_referenced_locally
	let status = $state.raw<EndpointsStatusResponse>(data.status);
	// A SET, not a single id: with one slot, rechecking ANY endpoint disabled
	// EVERY endpoint's button, on the one page whose job is comparing endpoints.
	// Both the handler guard and the `disabled` binding read this — changing only
	// the binding would leave the other buttons enabled but silently inert.
	const rechecking = new SvelteSet<string>();

	// Ticks once a second so elapsed times advance between the 3s polls.
	let nowMs = $state(Date.now());

	// The browser's clock minus the server's, measured on every snapshot. An
	// elapsed time computed from a raw `Date.now() - since` across two machines
	// can render as negative, which reads as a bug in the page rather than in
	// the clocks — so every duration goes through `elapsed()`, which subtracts
	// this back out.
	// svelte-ignore state_referenced_locally
	let skewMs = $state(Date.now() - data.status.now);

	/**
	 * Set when the server says this client may no longer read the page — a
	 * session that expired, or an admin whose role was revoked, while the tab sat
	 * open. Distinct from a transient failure on purpose: everything else is
	 * worth retrying silently, this is not, and a diagnostics page that keeps
	 * rendering a frozen snapshot with live-looking timers is worse than one that
	 * admits it stopped.
	 */
	let lostSession = $state(false);

	/**
	 * The `now` of the newest snapshot applied so far. Responses are not ordered:
	 * a poll issued before a Recheck can resolve after it, and applying it would
	 * revert the endpoint the operator just probed to its pre-probe health for up
	 * to a full poll interval — on this page, indistinguishable from a backend
	 * that is genuinely flapping. Server-stamped rather than a client sequence
	 * because both callers read from the same server clock, so it orders responses
	 * across the two of them without threading a counter through either.
	 */
	// svelte-ignore state_referenced_locally
	let appliedAt = $state(data.status.now);

	/**
	 * How far back a snapshot may be stamped and still be read as out-of-order
	 * rather than as the server's clock having stepped.
	 *
	 * Reordering is bounded by how long a response can be in flight — a poll
	 * interval plus a request, seconds at most. Anything older than this is not a
	 * late response, it is a different clock, and refusing it would freeze the
	 * view permanently: `appliedAt` is seeded once and the load re-running on
	 * refocus does not reseed it, so only a reload would recover. Silently, on
	 * the one page whose job is saying whether anything is happening.
	 */
	const REORDER_WINDOW_MS = 30_000;

	function applySnapshot(next: EndpointsStatusResponse) {
		// Stale — a newer snapshot already won. Bounded, so a clock step re-syncs
		// on the next poll instead of wedging.
		if (next.now < appliedAt && appliedAt - next.now < REORDER_WINDOW_MS) return;
		appliedAt = next.now;
		status = next;
		const at = Date.now();
		skewMs = at - next.now;
		// Re-stamp `nowMs` from the SAME instant the skew was measured. `elapsed`
		// computes `nowMs - skewMs - since`, so pairing a fresh skew with a `nowMs`
		// up to a second stale subtracts that staleness from every duration on
		// screen — durations visibly counted 4s, 3s, 5s. On a page whose whole job
		// is reporting how long something has been running, that is the one number
		// that has to be monotonic.
		nowMs = at;
	}

	async function poll() {
		try {
			const res = await fetch('/api/admin/endpoints/status');
			if (res.status === 401 || res.status === 403) {
				// Not transient, and not something another poll will fix: the session
				// went away or the role was revoked. Stop, and say so.
				lostSession = true;
				return;
			}
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
			if (!document.hidden && !lostSession) void poll();
		}, 3000);
		const tickTimer = setInterval(() => {
			// Frozen deliberately once the session is gone: advancing elapsed times
			// over a snapshot that can no longer be refreshed is the exact illusion
			// of liveness this is meant to remove.
			if (!document.hidden && !lostSession) nowMs = Date.now();
		}, 1000);
		// A tab returning to the foreground has a snapshot as stale as it was
		// away; refresh immediately rather than showing it for up to 3s more.
		const onVisible = () => {
			if (!document.hidden && !lostSession) {
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

	/**
	 * A probe that never answers must not hold the button hostage.
	 *
	 * The server bounds the upstream fetch by the endpoint's own
	 * `request_timeout_seconds` — 120 by default, and `config.toml.example`
	 * documents 600 for a bridge. That is the right budget for a generation and
	 * far too long for a diagnostic click: a black-holed host (firewall DROP —
	 * exactly why someone opens this page) would leave the control dead for
	 * minutes. This deadline is the UI's, deliberately independent of the
	 * endpoint's, and giving up on the response costs nothing because the 3s
	 * poll shows the probe's result the moment it lands.
	 */
	const RECHECK_TIMEOUT_MS = 15_000;

	async function recheck(endpointId: string) {
		if (rechecking.has(endpointId)) return;
		rechecking.add(endpointId);
		try {
			const res = await fetch(`/api/admin/endpoints/${encodeURIComponent(endpointId)}/recheck`, {
				method: 'POST',
				signal: AbortSignal.timeout(RECHECK_TIMEOUT_MS),
			});
			// Deliberately NOT treated as a lost session, unlike the poll's: this is
			// a POST to /api/*, so it also passes through the CSRF origin gate,
			// which answers 403 for a mismatched Origin on a browser that sends no
			// `Sec-Fetch-Site` behind a proxy that rewrites headers. Freezing the
			// whole page on that would give a wrong explanation and kill the GET
			// poll, which the gate never touches. A real session loss is caught by
			// the next poll within three seconds.
			if (!res.ok) {
				toast.error(await errorMessageFromResponse(res));
				return;
			}
			applySnapshot((await res.json()) as EndpointsStatusResponse);
		} catch {
			// Timed out or the tab went away. The probe is still running server-side
			// and lands in the cache, so the next poll reports it — nothing to say.
		} finally {
			rechecking.delete(endpointId);
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
			default:
				// Not `case 'unknown'`: a long-lived tab polls across deploys, so a
				// health state added server-side reaches an un-updated client, and an
				// exhaustive switch would return `undefined` and render it literally.
				// "Not yet checked" is the honest answer for a state this build can't
				// name.
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
			default:
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
			default:
				// A purpose added server-side must not render as `undefined` in a tab
				// that predates it — `other` is already this page's word for work it
				// cannot name.
				return 'Other';
		}
	}

	/** Model counts worth naming, in a stable order. Kinds with none are dropped
	 *  — "0 video" on a chat-only endpoint is noise, not information. */
	function kindBreakdown(ep: EndpointStatus): string {
		// Known kinds first, in a deliberate reading order, then anything else the
		// server reported. Iterating a hardcoded list alone would silently drop a
		// newly-added kind, leaving the breakdown summing to less than the model
		// count right beside it — a page that contradicts itself is worse than one
		// that shows an unfamiliar word.
		const order = ['chat', 'image', 'video', 'embedding'];
		const kinds = Object.keys(ep.modelsByKind).sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
		});
		return kinds
			.filter((k) => ep.modelsByKind[k as keyof typeof ep.modelsByKind] > 0)
			.map((k) => `${ep.modelsByKind[k as keyof typeof ep.modelsByKind]} ${k}`)
			.join(' · ');
	}

	/** A group is only worth drawing as a group when it actually has members
	 *  sharing a gate; the default one-endpoint-per-group case renders flat. */
	function isSharedGroup(g: EndpointGroupStatus): boolean {
		return g.endpoints.length > 1;
	}

	/** Slots actually generating — excludes one still freeing memory for a
	 *  handover, which is occupied but has not started. */
	function generatingCount(ep: EndpointStatus): number {
		return ep.active.filter((s) => s.state === 'active').length;
	}

	function capLabel(max: number | null): string {
		return max === null ? '∞' : String(max);
	}
</script>

<SettingsPage title="Endpoints">
	{#snippet description()}
		Health and live activity for the endpoints in <code class="font-mono">config.toml</code>.
		Read-only — endpoints are configured in that file and picked up on restart.
	{/snippet}

	<div class="mx-auto flex max-w-2xl flex-col gap-3">
		{#if lostSession}
			<!-- Above the snapshot rather than replacing it: the last-known picture is
			     still the most useful thing on screen, it just isn't live any more. -->
			<div class="rounded-md border px-3 py-2 text-xs alert-warning">
				<div class="font-medium">This view is no longer updating</div>
				<div class="mt-1">
					Your session ended or your admin access was removed, so the page below is frozen at its
					last reading. Reload to sign in again.
				</div>
			</div>
		{/if}
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
					disabled={rechecking.has(ep.id) || lostSession}
					title="Re-probe this endpoint now"
					class="rounded-md border border-border p-1.5 transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
					aria-label="Recheck {ep.displayName}"
				>
					<RefreshCw
						size={13}
						strokeWidth={2.25}
						class={rechecking.has(ep.id) ? 'animate-spin' : ''}
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
				<!-- `active` holds every occupied slot, including one whose model is
				     still being unloaded for a handover. That slot is taken but is not
				     generating, and the row below it says "freeing memory" — so
				     counting it here would have the tile contradict its own list. -->
				<dd class="mt-0.5 text-sm font-medium">{generatingCount(ep)}</dd>
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
				{#each ep.active as slot (slot.id)}
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
				{#each ep.queued as slot (slot.id)}
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
