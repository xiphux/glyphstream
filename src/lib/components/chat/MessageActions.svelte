<!--
	Per-message action toolbar: sibling branch navigation (‹ N/M › +
	delete-branch), copy, edit (user msgs), retry (assistant msgs), and a
	token-usage popover. Sits directly below a message bubble, aligned to
	the same side (right for user, left for assistant), revealed on hover
	at sm+.

	Purely presentational — every action is a callback the page wires to
	its copy/edit/retry/select-sibling/delete handlers.
-->
<script lang="ts">
	import { Popover } from 'bits-ui';
	import { Check, ChevronLeft, ChevronRight, Copy, Info, Pencil, RotateCcw, Trash2 } from '@lucide/svelte';
	import type { ChatMessage } from '$lib/types/api';

	interface Props {
		message: ChatMessage;
		generating: boolean;
		/** True while this message's copy confirmation checkmark is showing. */
		recentlyCopied: boolean;
		/** Whether the message has any copyable text (hides Copy when not). */
		canCopy: boolean;
		/** Tokens sent to the model at this user turn; only meaningful for
		 *  user messages, null otherwise. */
		userSentTokens: number | null;
		onCopy: () => void;
		onEdit: () => void;
		onRetry: () => void;
		onSelectSibling: (id: string) => void;
		onDeleteBranch: () => void;
	}

	let {
		message,
		generating,
		recentlyCopied,
		canCopy,
		userSentTokens,
		onCopy,
		onEdit,
		onRetry,
		onSelectSibling,
		onDeleteBranch
	}: Props = $props();

	const tokenFmt = new Intl.NumberFormat();

	const isUser = $derived(message.role === 'user');
	const showEdit = $derived(message.role === 'user');
	const showRetry = $derived(message.role === 'assistant');
	const assistantOut = $derived(message.role === 'assistant' ? (message.tokensOut ?? 0) : 0);
	const showTokens = $derived(
		(message.role === 'assistant' && assistantOut > 0) ||
			(message.role === 'user' && userSentTokens != null && userSentTokens > 0)
	);
	const siblingCount = $derived(message.siblingCount ?? 1);
	const hasSiblings = $derived(siblingCount > 1);
	const pos = $derived(message.siblingPosition ?? 1);
	const ids = $derived(message.siblingIds ?? [message.id]);
</script>

<div
	class="mt-1 flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 {isUser
		? 'justify-end'
		: 'justify-start'}"
>
	<!--
		For user bubbles (justify-end), CSS `order` pulls the sibling group
		flush to the left edge so the "‹ N/M › 🗑" cluster reads as one
		coherent unit, with Info bumped between siblings and copy/edit (via
		-order-1 below). Assistant bubbles get no order tweaks and follow
		DOM order.
	-->
	{#if hasSiblings}
		<button
			type="button"
			onclick={() => onSelectSibling(ids[pos - 2])}
			disabled={pos === 1 || generating}
			aria-label="Previous sibling"
			title="Previous"
			class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
			class:order-first={isUser}
		>
			<ChevronLeft size={14} strokeWidth={2.25} />
		</button>
		<span class="text-xs tabular-nums text-neutral-500" class:order-first={isUser}>
			{pos} / {siblingCount}
		</span>
		<button
			type="button"
			onclick={() => onSelectSibling(ids[pos])}
			disabled={pos === siblingCount || generating}
			aria-label="Next sibling"
			title="Next"
			class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
			class:order-first={isUser}
		>
			<ChevronRight size={14} strokeWidth={2.25} />
		</button>
		<!-- Trash this branch. Only meaningful (and only shown) when siblings
			 exist — deleting an only-branch would just be truncating the
			 conversation, a different operation that isn't exposed here.
			 Server defensively re-checks. -->
		<button
			type="button"
			onclick={onDeleteBranch}
			disabled={generating}
			aria-label="Delete this branch"
			title="Delete branch"
			class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-red-100 hover:text-red-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-red-950/40 dark:hover:text-red-300"
			class:order-first={isUser}
		>
			<Trash2 size={14} strokeWidth={2.25} />
		</button>
	{/if}
	{#if canCopy}
		<button
			type="button"
			onclick={onCopy}
			aria-label={recentlyCopied ? 'Copied' : 'Copy message'}
			title={recentlyCopied ? 'Copied' : 'Copy'}
			class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
		>
			{#if recentlyCopied}
				<Check size={14} strokeWidth={2.25} class="text-emerald-600 dark:text-emerald-400" />
			{:else}
				<Copy size={14} strokeWidth={2.25} />
			{/if}
		</button>
	{/if}
	{#if showEdit}
		<button
			type="button"
			onclick={onEdit}
			disabled={generating}
			aria-label="Edit message"
			title="Edit"
			class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
		>
			<Pencil size={14} strokeWidth={2.25} />
		</button>
	{/if}
	{#if showRetry}
		<button
			type="button"
			onclick={onRetry}
			disabled={generating}
			aria-label="Retry"
			title="Retry"
			class="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
		>
			<RotateCcw size={14} strokeWidth={2.25} />
		</button>
	{/if}
	{#if showTokens}
		<Popover.Root>
			<!--
				Action buttons are ordered most→least important from the bubble
				outward — Info, the "least likely" button, sits farthest from
				the bubble. For assistant bubbles (justify-start) that's the
				rightmost slot, which Info gets naturally via DOM order. For
				user bubbles (justify-end), the rightmost slot is *closest* to
				the bubble; `-order-1` flips Info ahead of copy/edit. The
				sibling group above takes `order-first` (-9999) so the chevrons
				stay glued together to the far left, with Info slotting in
				between siblings and the copy/edit cluster.
			-->
			<Popover.Trigger
				aria-label="Token usage for this message"
				title="Token usage"
				class="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-700 data-[state=open]:bg-neutral-200 data-[state=open]:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 dark:data-[state=open]:bg-neutral-800 dark:data-[state=open]:text-neutral-200 {isUser
					? '-order-1'
					: ''}"
			>
				<Info size={14} strokeWidth={2.25} />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					sideOffset={4}
					class="z-50 max-w-[260px] rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
				>
					{#if message.role === 'user'}
						<dl class="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 tabular-nums">
							<dt class="text-neutral-500">Sent to model</dt>
							<dd class="text-right font-medium text-neutral-900 dark:text-neutral-100">
								{tokenFmt.format(userSentTokens ?? 0)}
							</dd>
						</dl>
						<p class="mt-2 text-[11px] leading-snug text-neutral-500">
							Full conversation passed to the model at this turn — includes the
							system prompt and prior messages, not just this one.
						</p>
					{:else}
						<dl class="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 tabular-nums">
							<dt class="text-neutral-500">Generated</dt>
							<dd class="text-right font-medium text-neutral-900 dark:text-neutral-100">
								{tokenFmt.format(assistantOut)}
							</dd>
						</dl>
					{/if}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	{/if}
</div>
