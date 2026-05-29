<!--
	Shared "Delete this conversation?" confirm dialog.

	Both delete entry points — the sidebar conversation overflow menu
	and the /archived list — render this so they behave identically:
	same modal, same orphan-media checkbox, same Escape/backdrop
	dismissal. The /archived list previously fell back to a bare
	window.confirm(), which gave no way to also delete generated media
	and tripped the browser's "don't let this site show more dialogs"
	suppression after a few uses in a row.

	Division of labour: this component *asks the question*. It fetches
	the orphan-media counts, renders the modal, and reports the answer
	through onconfirm(id, deleteMedia). It deliberately does NOT issue
	the DELETE — the caller does, because the post-delete navigation
	differs (the sidebar may need to bounce off /chat/:id; the
	archived list just reloads its own data).

	Controlled via the bindable `targetId`: set it to a conversation
	id to open the dialog; the component clears it back to null itself
	on cancel / confirm / dismiss.
-->
<script lang="ts">
	import { toast } from '$lib/toast.svelte';

	type MediaCounts = { images: number; videos: number };

	let {
		targetId = $bindable(null),
		onconfirm
	}: {
		/** Conversation id to confirm deletion of, or null when closed. */
		targetId?: string | null;
		/** Fired on confirm. The caller performs the actual DELETE. */
		onconfirm: (id: string, deleteMedia: boolean) => void;
	} = $props();

	// Orphan-media counts for the current target, fetched when the
	// dialog opens. The modal renders only once this is populated, so
	// it appears already knowing whether to show the media checkbox —
	// no layout shift mid-dialog. Back to null whenever closed.
	let counts = $state<MediaCounts | null>(null);
	let deleteMediaToo = $state(false);

	// Plain (non-reactive) counter that scopes each orphan-media fetch
	// to the open that started it. If the user re-targets delete at a
	// different conversation before the first count fetch lands, the
	// stale response is dropped instead of populating the wrong modal.
	// Non-$state on purpose: mutating it must not re-run the effect.
	let fetchToken = 0;

	$effect(() => {
		const id = targetId;
		// Any count fetch from a previous target is now stale.
		const token = ++fetchToken;
		if (id === null) {
			counts = null;
			return;
		}
		// Fresh decision per conversation — never a sticky preference.
		deleteMediaToo = false;
		counts = null;
		fetch(`/api/conversations/${id}/orphan-media`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`Server returned ${res.status}`);
				return (await res.json()) as MediaCounts;
			})
			.then((c) => {
				if (token === fetchToken) counts = c;
			})
			.catch((e) => {
				// A superseded fetch failing is not the user's concern.
				if (token !== fetchToken) return;
				toast.error(
					`Couldn't open delete dialog: ${e instanceof Error ? e.message : String(e)}`
				);
				targetId = null;
			});
	});

	function cancel() {
		targetId = null;
	}

	function confirmDelete() {
		if (targetId === null) return;
		const id = targetId;
		const deleteMedia = deleteMediaToo;
		// Close first so the modal disappears immediately, then hand
		// the decision back to the caller to execute.
		targetId = null;
		onconfirm(id, deleteMedia);
	}

	function onWindowKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && targetId !== null) cancel();
	}

	function formatMediaCounts(c: MediaCounts): string {
		const parts: string[] = [];
		if (c.images > 0) {
			parts.push(`${c.images} ${c.images === 1 ? 'image' : 'images'}`);
		}
		if (c.videos > 0) {
			parts.push(`${c.videos} ${c.videos === 1 ? 'video' : 'videos'}`);
		}
		return parts.join(' and ');
	}
</script>

<svelte:window onkeydown={onWindowKey} />

<!--
	role=alertdialog rather than role=dialog because the action is
	destructive — alertdialog signals to assistive tech that the
	dialog needs explicit user input before dismissal (no auto-close
	on focus loss). Backdrop click cancels; Escape cancels.

	`counts` non-null is the open condition: it is only ever set while
	a target is active and is cleared the moment the dialog closes.
-->
{#if counts}
	{@const c = counts}
	{@const hasMedia = c.images > 0 || c.videos > 0}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
	<div
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="delete-conv-title"
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) cancel();
		}}
	>
		<div
			class="w-full max-w-md rounded-lg border border-border bg-surface-panel p-5 shadow-xl"
		>
			<h2 id="delete-conv-title" class="text-base font-semibold">
				Delete this conversation?
			</h2>
			<p class="mt-2 text-sm text-fg-muted">
				This action cannot be undone.
			</p>
			{#if hasMedia}
				<!--
					Default unchecked = library-model behavior: deleting the
					conversation by itself doesn't touch gallery items,
					mirroring how deleting an email doesn't touch a separate
					photo library. Checking opts into the tightly-coupled
					outcome for this delete only.
				-->
				<label
					class="mt-4 flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-neutral-50 p-3 text-sm dark:bg-neutral-800/40"
				>
					<input type="checkbox" bind:checked={deleteMediaToo} class="mt-0.5" />
					<span>
						Also delete <span class="font-medium">{formatMediaCounts(c)}</span>
						from gallery.
					</span>
				</label>
			{/if}
			<div class="mt-5 flex items-center justify-end gap-2">
				<button
					type="button"
					onclick={cancel}
					class="rounded-md border border-border-strong bg-surface-panel px-4 py-2 text-sm transition hover:bg-surface-raised"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={confirmDelete}
					class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700"
				>
					Delete
				</button>
			</div>
		</div>
	</div>
{/if}
