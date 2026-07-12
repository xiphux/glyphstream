<!--
	The contents of the context budget, itemized — what `ContextBudgetBar` shows a
	single number for.

	The split into "every turn" vs "history" is the point of the panel, not a
	cosmetic grouping: compaction can only reclaim the second group. A thread whose
	bulk is tool definitions and saved memories will not get smaller no matter how
	many times you compact it, and before this panel there was no way to see that —
	you'd just watch the Compact button fail to help.

	Fetched lazily on open (the endpoint re-runs the full request assembly), and
	refetched whenever the turn count changes so it doesn't go stale behind you.
-->
<script lang="ts">
	import type { ContextBreakdown, ContextSegment, ContextSegmentKey } from '$lib/types/api';

	interface Props {
		conversationId: string;
		/** Bumped by the parent on every completed turn — invalidates the cache. */
		revision: number;
	}

	let { conversationId, revision }: Props = $props();

	const tokenFmt = new Intl.NumberFormat();

	const LABELS: Record<ContextSegmentKey, string> = {
		'persona:name': 'Your name',
		'persona:about': 'About you',
		'persona:instructions': 'Custom instructions',
		'persona:memories': 'Saved memories',
		'persona:overview': 'Conversation topics',
		'system:custom': 'System prompt',
		'skills:catalog': 'Skills catalog',
		'tools:hint': 'Deferred-tool hint',
		'tools:defs': 'Tool definitions',
		'history:summary': 'Compaction summary',
		'history:text': 'Messages',
		'history:tool_calls': 'Tool calls',
		'history:tool_results': 'Tool results',
		'history:images': 'Images',
	};

	/** Segments re-sent verbatim on every turn. Compaction cannot touch these. */
	const OVERHEAD: ReadonlySet<ContextSegmentKey> = new Set([
		'persona:name',
		'persona:about',
		'persona:instructions',
		'persona:memories',
		'persona:overview',
		'system:custom',
		'skills:catalog',
		'tools:hint',
		'tools:defs',
	]);

	let data = $state<ContextBreakdown | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);
	let loadedRevision = $state(-1);

	async function load() {
		if (loading || loadedRevision === revision) return;
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/conversations/${conversationId}/context`);
			if (!res.ok) throw new Error(`${res.status}`);
			data = await res.json();
			loadedRevision = revision;
		} catch {
			error = 'Could not measure the context.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void revision;
		void load();
	});

	const overhead = $derived(data?.segments.filter((s) => OVERHEAD.has(s.key)) ?? []);
	const history = $derived(data?.segments.filter((s) => !OVERHEAD.has(s.key)) ?? []);

	const sum = (segs: ContextSegment[]) => segs.reduce((n, s) => n + s.tokens, 0);
	/** Widest segment, so the bars are scaled against something meaningful rather
	 *  than against the window (where every row would be a sliver). */
	const peak = $derived(Math.max(1, ...(data?.segments ?? []).map((s) => s.tokens)));

	/** Base64 is one wire byte per character, so the image segment's `chars` IS
	 *  what those images cost the request — bigger than the files on disk by the
	 *  usual ~33% encoding overhead. Quote the wire figure, since that's the one
	 *  being paid every turn. */
	const imageWireBytes = $derived(
		data?.segments.find((s) => s.key === 'history:images')?.chars ?? 0,
	);

	function mb(bytes: number): string {
		return `${(bytes / 1_000_000).toFixed(1)} MB`;
	}
</script>

<div class="flex flex-col gap-3 p-3 text-xs">
	{#if loading && !data}
		<p class="text-fg-muted">Measuring…</p>
	{:else if error}
		<p class="text-warning">{error}</p>
	{:else if data}
		{@render group('Sent every turn', overhead, 'Compaction cannot shrink these.')}
		{@render group('Conversation history', history, 'This is what compacting frees up.')}

		<div class="border-t border-border pt-2 text-fg-muted">
			{#if data.reportedPromptTokens !== null}
				<p>
					Upstream reported <span class="tabular-nums text-fg-secondary"
						>{tokenFmt.format(data.reportedPromptTokens)}</span
					>
					prompt tokens last turn; the estimate above is
					<span class="tabular-nums">{tokenFmt.format(data.estimatedTokens)}</span>.
				</p>
			{/if}
			{#if imageWireBytes > 0}
				<p class="mt-1">
					Images are re-uploaded as {mb(imageWireBytes)} of base64 on every turn. Their token cost is
					set by the model's tiling, not by their size, so it isn't in the estimate — it's most of the
					gap above.
				</p>
			{:else}
				<p class="mt-1">Estimated at ~4 characters per token; the upstream's count is exact.</p>
			{/if}
		</div>
	{/if}
</div>

{#snippet group(title: string, segments: ContextSegment[], caption: string)}
	{#if segments.length > 0}
		<section>
			<header class="mb-1.5 flex items-baseline justify-between gap-2">
				<h3 class="font-medium text-fg-secondary">{title}</h3>
				<span class="tabular-nums text-fg-muted">{tokenFmt.format(sum(segments))} tok</span>
			</header>
			<ul class="flex flex-col gap-1">
				{#each segments as s (s.key)}
					<li>
						<div class="flex items-baseline justify-between gap-2">
							<span class="truncate" title={s.items?.map((i) => i.label).join(', ')}>
								{LABELS[s.key]}
							</span>
							<span class="shrink-0 tabular-nums text-fg-muted">
								{#if s.key === 'history:images'}
									{mb(s.chars)}
								{:else}
									{tokenFmt.format(s.tokens)}
								{/if}
							</span>
						</div>
						<!-- Images carry no estimated token count (see ContextBreakdown.imageBytes),
						     so a bar scaled by tokens would render an empty sliver and read as
						     "images are free". Show the size instead and no bar. -->
						{#if s.key !== 'history:images'}
							<div class="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-raised">
								<div
									class="h-full rounded-full bg-accent/60"
									style="width: {Math.max(1, Math.round((s.tokens / peak) * 100))}%"
								></div>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="mt-1 text-[0.6875rem] text-fg-muted">{caption}</p>
		</section>
	{/if}
{/snippet}
