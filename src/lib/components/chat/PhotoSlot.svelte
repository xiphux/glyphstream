<!--
	One `[photo: …]` of a reply, where the model put it: the version on show,
	with arrows between versions and buttons to develop it again or remove this
	one — or, before it's developed, a placeholder with its description and a
	Develop button. Shared by both reply styles: a texting reply draws it as a
	text of its own (TextingBubbles), a standard one inside its bubble
	(`inBubble`).

	`portrait` is the same thing for an avatar portrait drawn from the reply:
	square, worded as drawing, and nothing to show until a draw exists — it has
	no marker to stand in for.
-->
<script lang="ts">
	import { Camera, ChevronLeft, ChevronRight, RefreshCw, Trash2, UserRound } from '@lucide/svelte';
	import { cssAspectRatio } from '#lib/aspect-ratio.js';
	import type { TextingPhotos } from '#lib/texting.js';
	import type { MessageImage } from '#lib/types/api.js';

	interface Props {
		/** Which of the reply's photos, as `textingItems` numbers them. */
		index: number;
		description: string;
		/** The reply's photos and what can be done with them; absent for a reply
		 *  still arriving, whose photos can't be developed yet. */
		photos?: TextingPhotos;
		onImageClick: (mediaId: string) => void;
		openingLightboxFor?: string | null;
		/** Inside a standard reply's bubble, rather than a text of its own. */
		inBubble?: boolean;
		/** An avatar portrait rather than a photo. */
		portrait?: boolean;
	}

	let {
		index,
		description,
		photos,
		onImageClick,
		openingLightboxFor = null,
		inBubble = false,
		portrait = false,
	}: Props = $props();

	const noun = $derived(portrait ? 'portrait' : 'photo');
	const verb = $derived(portrait ? 'draw' : 'develop');
	const working = $derived(portrait ? 'Drawing…' : 'Developing…');

	const photoButton = 'rounded-full bg-black/55 p-1.5 text-white transition hover:bg-black/70';

	/** The photo's developed versions (with an image), the one on show, and
	 *  whether its latest attempt failed. */
	const state = $derived.by(() => {
		const all = photos?.versions.get(index) ?? [];
		const versions = all.filter((v): v is MessageImage & { mediaId: string } => !!v.mediaId);
		const shown = versions.find((v) => v.shown) ?? null;
		const failed = all.findLast((v) => !v.mediaId) ?? null;
		// Developing it again failed: a failure since the version on show was
		// drawn, and not a comparison's — a model that failed beside the result
		// now showing is no news about this photo.
		const failedAgain =
			failed && shown && !failed.inComparison && failed.createdAt > shown.createdAt
				? failed.error
				: null;
		return {
			versions,
			shown,
			failure: failed?.error ?? null,
			failedAgain,
			developing: photos?.developing.has(index) ?? false,
		};
	});
</script>

{#if state.shown}
	{@const shown = state.shown}
	{@const at = state.versions.indexOf(shown)}
	<div class={['flex max-w-[75%] flex-col gap-1', portrait ? 'w-40' : 'w-64', inBubble && 'my-2']}>
		<div class="relative">
			<button
				type="button"
				onclick={() => onImageClick(shown.mediaId)}
				aria-label="Open {noun}"
				disabled={openingLightboxFor === shown.mediaId}
				class="block w-full overflow-hidden rounded-2xl p-0 transition disabled:opacity-60"
			>
				<img
					src="/api/media/{shown.mediaId}/display"
					alt={description}
					loading="lazy"
					style:aspect-ratio={cssAspectRatio({
						width: shown.width ?? undefined,
						height: shown.height ?? undefined,
						aspectRatio: shown.aspectRatio ?? undefined,
					})}
					class="block h-auto max-h-[70vh] w-full object-cover"
				/>
			</button>
			<div class="absolute top-2 right-2 flex gap-1">
				{#if photos?.onDevelop && !state.developing}
					<button
						type="button"
						onclick={() => photos?.onDevelop?.(index)}
						aria-label={portrait ? 'Draw again' : 'Develop again'}
						title={portrait ? 'Draw again' : 'Develop again'}
						class={photoButton}
					>
						<RefreshCw class="size-3.5" aria-hidden="true" />
					</button>
				{/if}
				{#if photos?.onRemove}
					<button
						type="button"
						onclick={() => photos?.onRemove?.(shown)}
						aria-label="Remove this {noun}"
						title="Remove this {noun}"
						class={photoButton}
					>
						<Trash2 class="size-3.5" aria-hidden="true" />
					</button>
				{/if}
			</div>
			<!-- Up here, not in place of the arrows: a comparison of many models
			     can take minutes, and what has landed is worth looking through. -->
			{#if state.developing}
				<p class="absolute top-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-xs text-white">
					{working}
				</p>
			{/if}
			{#if state.versions.length > 1}
				<div
					class="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/55 px-1 text-xs text-white"
				>
					<button
						type="button"
						onclick={() => photos?.onShow?.(state.versions[at - 1])}
						disabled={at === 0 || !photos?.onShow}
						aria-label="Previous version"
						class="rounded-full p-1 transition hover:bg-black/40 disabled:opacity-40"
					>
						<ChevronLeft class="size-3.5" aria-hidden="true" />
					</button>
					<span class="tabular-nums">{at + 1}/{state.versions.length}</span>
					<button
						type="button"
						onclick={() => photos?.onShow?.(state.versions[at + 1])}
						disabled={at === state.versions.length - 1 || !photos?.onShow}
						aria-label="Next version"
						class="rounded-full p-1 transition hover:bg-black/40 disabled:opacity-40"
					>
						<ChevronRight class="size-3.5" aria-hidden="true" />
					</button>
				</div>
			{/if}
		</div>
		<!-- Developing it again failed: the photo on show is the last one
	     that worked, so say why there's no new one. -->
		{#if state.failedAgain && !state.developing}
			<p class="text-xs text-danger">Couldn't {verb} again: {state.failedAgain}</p>
		{/if}
	</div>
{:else if !portrait || state.developing || state.failure}
	<div
		class={[
			'flex max-w-[85%] flex-col gap-1.5 rounded-2xl border border-dashed border-border-strong px-3.5 py-2.5',
			portrait ? 'w-40' : 'w-60',
			inBubble ? 'my-2 bg-surface-sunken' : 'bg-surface-raised',
		]}
	>
		<div class="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
			{#if portrait}
				<UserRound class="size-3.5" aria-hidden="true" />
				Portrait
			{:else}
				<Camera class="size-3.5" aria-hidden="true" />
				Photo
			{/if}
		</div>
		{#if !portrait}
			<p class="line-clamp-4 text-sm italic text-fg-secondary">{description}</p>
		{/if}
		{#if state.developing}
			<p class="text-xs text-fg-muted">{working}</p>
		{:else}
			{#if state.failure}
				<p class="text-xs text-danger">Couldn't {verb}: {state.failure}</p>
			{/if}
			{#if photos?.onDevelop}
				<button
					type="button"
					onclick={() => photos?.onDevelop?.(index)}
					class="self-start rounded-md bg-surface-inverse px-3 py-1 text-xs font-medium text-fg-inverse transition hover:opacity-90"
				>
					{state.failure ? 'Try again' : 'Develop'}
				</button>
			{/if}
		{/if}
	</div>
{/if}
