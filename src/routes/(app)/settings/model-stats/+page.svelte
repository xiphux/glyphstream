<!--
	Model stats: which models are used, and how their output is received —
	for deciding which ones earn their disk space.

	Grouped by endpoint, local first: an idle local model is gigabytes worth
	reclaiming, an idle hosted one costs nothing. Each endpoint shows the models
	that did something (or hold a configured job) and folds the rest into
	collapsed "unused" / "no longer offered" lists, so a hosted catalogue's
	hundreds of untouched models don't bury the page.

	All the reading of counters into rates and flags lives in `#lib/model-stats`.
-->
<script lang="ts">
	import SettingsPage from '#lib/components/settings/SettingsPage.svelte';
	import {
		bucketOf,
		chatSignals,
		daysOfData,
		flagsFor,
		formatRate,
		isMediaModel,
		isNewModel,
		mediaSignals,
		type Rate,
	} from '#lib/model-stats.js';
	import type {
		ModelStatsEndpoint,
		ModelStatsModel,
		ModelStatsWindow,
		ModelTaskRole,
	} from '#lib/types/api.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const report = $derived(data.report);

	const WINDOWS: Array<{ value: ModelStatsWindow; label: string }> = [
		{ value: '30d', label: '30 days' },
		{ value: '90d', label: '90 days' },
		{ value: 'all', label: 'All time' },
	];

	const ROLE_LABELS: Record<ModelTaskRole, string> = {
		title: 'Title model',
		memory: 'Memory model',
		enhance: 'Prompt enhancer',
		embeddings: 'Embeddings',
		rerank: 'Reranker',
	};

	const TASK_LABELS: Record<string, string> = {
		'task:title': 'titles',
		'task:topic': 'topic labels',
		'task:memory': 'memory passes',
		'task:dream': 'consolidations',
		'task:compaction': 'compactions',
		'task:enhance': 'prompt enhancements',
		'task:embed': 'embedding calls',
		'task:rerank': 'rerank calls',
	};

	interface Grouped {
		endpoint: ModelStatsEndpoint;
		active: ModelStatsModel[];
		unused: ModelStatsModel[];
		retired: ModelStatsModel[];
	}

	const grouped = $derived(
		report.endpoints.map((endpoint): Grouped => {
			const g: Grouped = { endpoint, active: [], unused: [], retired: [] };
			for (const m of endpoint.models) g[bucketOf(m)].push(m);
			// Longest idle first: the strongest removal candidates lead.
			g.unused.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
			return g;
		}),
	);

	const numberFormat = new Intl.NumberFormat();
	const n = (x: number) => numberFormat.format(x);

	function lastUsedLabel(at: number | null): string {
		if (at === null) return 'never used';
		const days = Math.floor((Date.now() - at) / 86_400_000);
		if (days < 1) return 'last used today';
		if (days < 60) return `last used ${days}d ago`;
		return `last used ${new Date(at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
	}

	function kindLabel(m: ModelStatsModel): string | null {
		switch (m.kind) {
			case 'chat':
				return 'Chat';
			case 'image':
				return 'Image';
			case 'video':
				return 'Video';
			case 'embedding':
				return 'Embedding';
			default:
				return null;
		}
	}

	// Plain text, deliberately uncoloured: "Retried 2%" in red would alarm over
	// a normal rate. Colour is reserved for the flags, which need evidence.
	interface Stat {
		text: string;
		title?: string;
	}

	function rateStat(label: string, rate: Rate, title: string): Stat[] {
		const r = formatRate(rate);
		return r && rate.k > 0 ? [{ text: `${label} ${r}`, title }] : [];
	}

	function picksStat(label: string, rate: Rate, title: string): Stat[] {
		return rate.n > 0 ? [{ text: `${label} ${rate.k} of ${rate.n}`, title }] : [];
	}

	/** The model's own numbers, most important first; zeros left out. */
	function statsFor(m: ModelStatsModel): Stat[] {
		const out: Stat[] = [];
		if (isMediaModel(m)) {
			const sig = mediaSignals(m);
			if (sig.generated > 0) {
				out.push({ text: `${n(sig.generated)} ${m.kind === 'video' ? 'videos' : 'images'}` });
			}
			if (sig.avgSeconds !== null) {
				out.push({
					text: sig.avgSeconds < 0.1 ? '<0.1s avg' : `${sig.avgSeconds.toFixed(1)}s avg`,
					title: 'Average generation time',
				});
			}
			out.push(
				...rateStat('Favorited', sig.favorites, 'Outputs starred in the gallery'),
				...rateStat(
					'Built on',
					sig.used,
					'Outputs used as the input to another generation, or as an avatar',
				),
				...rateStat('Deleted', sig.rejected, 'Outputs the user deleted (net of restores)'),
				...rateStat('Failed', sig.failures, 'Generations that failed'),
				...picksStat('Avatar pick', sig.avatarPicked, 'Chosen in multi-model avatar comparisons'),
				...picksStat('Picked', sig.picked, 'Chosen in side-by-side comparisons'),
			);
		} else {
			const sig = chatSignals(m);
			if (sig.turns > 0) out.push({ text: `${n(sig.turns)} turns` });
			if (sig.tokensPerSecond !== null) {
				out.push({ text: `${Math.round(sig.tokensPerSecond)} tok/s`, title: 'Generation speed' });
			}
			out.push(
				...picksStat('Picked', sig.picked, 'Chosen in side-by-side comparisons'),
				...rateStat('Retried', sig.retries, 'Replies regenerated'),
				...rateStat('Errors', sig.errors, 'Turns that failed'),
				...rateStat('Cut off', sig.truncated, 'Replies stopped at the length limit'),
				...rateStat('Branch deleted', sig.branchesDeleted, 'Replies whose branch was deleted'),
			);
			out.push(
				...rateStat(
					'Switched away',
					sig.switchedAway,
					'Turns after which the conversation moved to another chat model',
				),
			);
			if (sig.stoppedThenRetried + sig.stoppedThenEdited > 0) {
				out.push({
					text: `Stopped → retried ${sig.stoppedThenRetried}, edited ${sig.stoppedThenEdited}`,
					title:
						'After stopping a reply: a retry says the model went wrong, an edit says the prompt did',
				});
			}
		}
		for (const [metric, label] of Object.entries(TASK_LABELS)) {
			const count = m.counts[metric] ?? 0;
			if (count > 0) out.push({ text: `${n(count)} ${label}` });
		}
		return out;
	}

	function peopleLabel(m: ModelStatsModel): string | null {
		if (m.usedBy === 0) return null;
		return m.usedBy === 1 ? '1 person' : `${m.usedBy} people`;
	}

	function presetsLabel(m: ModelStatsModel): string | null {
		const used = m.presets.filter((p) => p.chats > 0);
		if (used.length === 0) return null;
		const named = used.filter((p) => p.name !== null);
		const others = used.filter((p) => p.name === null);
		const parts = named.map((p) => `${p.name} (${p.chats})`);
		if (others.length > 0) {
			const chats = others.reduce((x, p) => x + p.chats, 0);
			parts.push(`${others.length} other${others.length === 1 ? '' : 's'} (${chats})`);
		}
		return `Presets: ${parts.join(', ')}`;
	}

	const windowLabel = $derived(WINDOWS.find((w) => w.value === report.window)?.label ?? '');
</script>

<svelte:head><title>Model stats · GlyphStream</title></svelte:head>

<SettingsPage title="Model stats">
	{#snippet description()}
		How much each model is used and how its output is received — for deciding which models are worth
		keeping. Counted from when stats began; earlier history is partial.
	{/snippet}

	<div class="mx-auto flex max-w-3xl flex-col gap-4">
		<nav aria-label="Period" class="flex w-fit gap-1 rounded-lg border border-border p-0.5 text-xs">
			{#each WINDOWS as w (w.value)}
				<a
					href="?window={w.value}"
					data-sveltekit-noscroll
					aria-current={report.window === w.value ? 'page' : undefined}
					class="rounded-md px-2.5 py-1 transition {report.window === w.value
						? 'bg-surface-raised font-medium text-fg'
						: 'text-fg-muted hover:text-fg'}"
				>
					{w.label}
				</a>
			{/each}
		</nav>

		{#if grouped.length === 0}
			<div class="panel-card p-6 text-center text-sm text-fg-muted">No endpoints configured.</div>
		{/if}

		{#each grouped as g (g.endpoint.id)}
			<section class="panel-card p-4" aria-labelledby="ep-{g.endpoint.id}">
				<header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
					<div class="flex min-w-0 items-baseline gap-2">
						<h2 id="ep-{g.endpoint.id}" class="truncate text-base font-medium">
							{g.endpoint.displayName}
						</h2>
						{#if g.endpoint.removed}
							<span class="badge">Removed from config</span>
						{:else if g.endpoint.local}
							<span class="badge badge-accent">Local</span>
						{:else}
							<span class="badge">Hosted</span>
						{/if}
					</div>
					<p class="text-xs text-fg-muted">
						{g.active.length} in use{g.unused.length > 0 ? ` · ${g.unused.length} unused` : ''}
						· {windowLabel.toLowerCase()}
					</p>
				</header>

				{#if g.endpoint.listingUnavailable}
					<p class="mt-3 rounded-md border px-3 py-2 text-xs alert-warning">
						Couldn't list this endpoint's models, so its unused models can't be shown.
					</p>
				{/if}

				{#if g.active.length > 0}
					<ul class="mt-3 divide-y divide-border">
						{#each g.active as m (m.id)}
							{@render modelRow(m)}
						{/each}
					</ul>
				{:else if !g.endpoint.listingUnavailable}
					<p class="mt-3 text-sm text-fg-muted">Nothing used in this period.</p>
				{/if}

				{#if g.unused.length > 0}
					<details class="mt-3 rounded-md border border-border">
						<summary class="cursor-pointer px-3 py-2 text-sm">
							{g.unused.length} unused model{g.unused.length === 1 ? '' : 's'}
							{#if g.endpoint.local}
								<span class="text-fg-muted">— candidates to remove</span>
							{/if}
						</summary>
						<ul class="border-t border-border px-3 py-2 text-sm">
							{#each g.unused as m (m.id)}
								<li class="flex flex-wrap items-baseline justify-between gap-x-3 py-1">
									<span class="min-w-0 truncate">{m.displayName}</span>
									<span class="text-xs text-fg-muted">
										{lastUsedLabel(m.lastUsedAt)}{m.favoritedBy > 0
											? ` · favorite of ${m.favoritedBy}`
											: ''}
									</span>
								</li>
							{/each}
						</ul>
					</details>
				{/if}

				{#if g.retired.length > 0}
					<details class="mt-3 rounded-md border border-border">
						<summary class="cursor-pointer px-3 py-2 text-sm">
							{g.retired.length} no longer offered
						</summary>
						<ul class="border-t border-border px-3 py-2 text-sm text-fg-muted">
							{#each g.retired as m (m.id)}
								<li class="flex flex-wrap items-baseline justify-between gap-x-3 py-1">
									<span class="min-w-0 truncate">{m.displayName}</span>
									<span class="text-xs">{lastUsedLabel(m.lastUsedAt)}</span>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</section>
		{/each}
	</div>
</SettingsPage>

{#snippet modelRow(m: ModelStatsModel)}
	{@const stats = statsFor(m)}
	{@const people = peopleLabel(m)}
	{@const presets = presetsLabel(m)}
	<li class="py-2.5">
		<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
			<span class="min-w-0 truncate text-sm font-medium" title={m.upstreamId}>{m.displayName}</span>
			{#if kindLabel(m)}
				<span class="text-xs text-fg-muted">{kindLabel(m)}</span>
			{/if}
			{#each m.roles as role (role)}
				<span class="badge">{ROLE_LABELS[role]}</span>
			{/each}
			{#if !m.listed && m.roles.length === 0}
				<span class="badge" title="The endpoint no longer lists this model">Retired</span>
			{/if}
			{#if isNewModel(m)}
				{@const days = daysOfData(m)}
				<span
					class="badge badge-accent"
					title="Only recently put to use: a short history, so its numbers may still move. A flag still needs enough evidence to appear."
				>
					New · {days} day{days === 1 ? '' : 's'} of data
				</span>
			{/if}
			{#each flagsFor(m) as flag (flag.label)}
				<span class="badge {flag.tone === 'good' ? 'badge-good' : 'badge-bad'}" title={flag.detail}>
					{flag.label}
				</span>
			{/each}
		</div>
		{#if stats.length > 0 || people || m.favoritedBy > 0}
			<p class="stats mt-1 flex flex-wrap gap-y-0.5 text-xs text-fg-muted">
				{#if people}<span>{people}</span>{/if}
				{#if m.favoritedBy > 0}
					<span title="People with this model among their favorites">
						Favorite of {m.favoritedBy}
					</span>
				{/if}
				{#each stats as stat (stat.text)}
					<span title={stat.title}>{stat.text}</span>
				{/each}
			</p>
		{/if}
		{#if presets}
			<p class="mt-0.5 text-xs text-fg-muted">{presets}</p>
		{/if}
	</li>
{/snippet}

<style>
	.stats > span + span::before {
		content: '·';
		padding: 0 0.4rem;
	}
	.badge {
		border: 1px solid var(--color-border);
		border-radius: 9999px;
		padding: 0 0.45rem;
		font-size: 11px;
		line-height: 1.25rem;
		color: var(--color-fg-muted);
		white-space: nowrap;
	}
	.badge-accent {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.badge-good {
		border-color: var(--color-success);
		color: var(--color-success);
	}
	.badge-bad {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}
</style>
