<!--
	Compact "non-image file attached" chip — used everywhere we surface a
	media row with `kind: 'file'`: composer pre-send strip (where the
	in-flight upload is still uploading/erroring) and persisted message
	bubbles (where the chip is a finalized download affordance).

	Why a chip and not a preview: spreadsheets / PDFs / archives don't
	have a visual representation that helps the user identify them — a
	thumbnail of the first PDF page or an Excel logo placeholder both
	convey less than the filename does. The chip optimizes for
	"recognize and click to download" rather than "preview at a glance".

	Props are flat (filename / byteSize / href) rather than passing a
	whole media row or composer item, so this stays usable from any
	caller without coupling to either store's shape.
-->
<script lang="ts">
	import { AlertCircle, FileText, X } from '@lucide/svelte';

	let {
		filename,
		byteSize,
		href = null,
		status = 'ready',
		error = null,
		onRemove = null,
	}: {
		/** Display label. Truncated visually if it overflows. */
		filename: string;
		/** Used for the "12 KB" / "2.4 MB" subtitle. */
		byteSize: number;
		/** Download link target. Null for the in-composer / pre-upload state
		 *  where there's no server-side row to point at yet. */
		href?: string | null;
		/** Drives the visual state — same vocabulary as composer attachments
		 *  so a single component handles "still uploading" and "persisted in
		 *  a message" without two divergent codepaths. */
		status?: 'uploading' | 'ready' | 'error';
		/** Surfaced as the chip title (tooltip) when status === 'error'. */
		error?: string | null;
		/** When provided, a small × button appears on hover (composer state).
		 *  Omit for persisted-message rendering where removal isn't a thing. */
		onRemove?: (() => void) | null;
	} = $props();

	function humanSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<div
	class="group/chip relative flex max-w-xs items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs"
	title={status === 'error' && error ? error : filename}
>
	<div
		class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-muted {status ===
		'error'
			? 'bg-danger/15 text-danger'
			: 'bg-surface'}"
	>
		{#if status === 'uploading'}
			<div
				class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-fg-muted border-t-transparent"
			></div>
		{:else if status === 'error'}
			<AlertCircle size={16} strokeWidth={2} />
		{:else}
			<FileText size={16} strokeWidth={2} />
		{/if}
	</div>

	<div class="flex min-w-0 flex-col">
		{#if href && status === 'ready'}
			<a {href} download={filename} class="truncate text-fg-primary hover:underline">
				{filename}
			</a>
		{:else}
			<span class="truncate text-fg-primary">{filename}</span>
		{/if}
		<span class="text-fg-muted">{humanSize(byteSize)}</span>
	</div>

	{#if onRemove}
		<button
			type="button"
			onclick={onRemove}
			aria-label="Remove attachment"
			title="Remove"
			class="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-muted opacity-0 transition group-hover/chip:opacity-100 hover:bg-surface focus-visible:opacity-100"
		>
			<X size={12} strokeWidth={2.5} />
		</button>
	{/if}
</div>
