/**
 * Sidebar conversation mutation orchestration: the busy-state, toasts,
 * navigation, Undo flow, inline-rename state machine, and delete-
 * confirmation handoff that wrap the low-level fetches in
 * $lib/conversation-actions.
 *
 * Lives separately from the (app) layout so the rename state machine
 * (renamingId, renameDraft, renameOriginal, focus management) and the
 * cross-mutation `busyId` aren't tangled with the rest of the layout's
 * unrelated concerns (sidebar layout, drawer state, theme, MCP toggles).
 * Pure helpers (shouldCommitRename) are exported separately and
 * unit-tested.
 */

import { tick } from 'svelte';
import {
	deleteConversation as deleteConversationApi,
	renameConversation as renameConversationApi,
	setArchived,
} from './conversation-actions';
import { toast } from './toast.svelte';

/**
 * Decide whether a rename should actually fire a PATCH given the
 * trimmed draft and original. Empty input is treated as cancel; an
 * unchanged value (after trim) is a no-op. Split out as a pure
 * function so the equality / trim semantics are testable in isolation —
 * subtle whitespace bugs here would result in spurious "are you sure"
 * dialogs or accidental clears.
 */
export function shouldCommitRename(
	draft: string,
	original: string,
): { commit: false } | { commit: true; next: string } {
	const next = draft.trim();
	if (next.length === 0) return { commit: false };
	if (next === original.trim()) return { commit: false };
	return { commit: true, next };
}

export interface ConversationUiActionsDeps {
	/** Current page pathname. Read each call so post-mutation redirect
	 *  decisions react to navigation that happened mid-flight. */
	getPathname: () => string;
	/** SvelteKit's `goto`, surfaced as a dep so the class doesn't need
	 *  to import from `$app/navigation` directly (keeps the import
	 *  graph testable in the node vitest env). */
	goto: (url: string, opts?: { invalidateAll?: boolean }) => Promise<void>;
	/** SvelteKit's `invalidateAll`. */
	invalidateAll: () => Promise<void>;
}

export class ConversationUiActions {
	/** id of the conversation currently undergoing archive/delete — drives
	 *  the sidebar's pointer-events-none and the `if (busyId)` guards.
	 *  Read by the template; never mutated by the caller. */
	busyId = $state<string | null>(null);
	/** When non-null, the DeleteConversationDialog opens with this id. */
	deleteTargetId = $state<string | null>(null);

	/** Conversation id whose title input is open for editing. */
	renamingId = $state<string | null>(null);
	renameDraft = $state('');
	renameOriginal = $state('');
	/** Bind from the template: `<input bind:this={ui.renameInputEl}>`. */
	renameInputEl = $state<HTMLInputElement | null>(null);

	#deps: ConversationUiActionsDeps;

	constructor(deps: ConversationUiActionsDeps) {
		this.#deps = deps;
	}

	archive = async (id: string): Promise<void> => {
		if (this.busyId) return;
		this.busyId = id;
		// Capture before any navigation so the Undo handler can decide
		// whether to bring the user back to where they were.
		const wasViewingChat = this.#deps.getPathname() === `/chat/${id}`;
		try {
			await setArchived(id, true);
			// Archive is "I'm done with this thread" in the same spirit
			// as delete — the user is signaling they want it out of
			// their immediate view. Mirror delete's behavior and send
			// them to the new-chat surface rather than pulling them
			// deeper into the archive. The toast below confirms the
			// action and offers Undo so a misclick is one tap to recover
			// instead of a trip through /archived.
			if (wasViewingChat) {
				await this.#deps.goto('/', { invalidateAll: true });
			} else {
				await this.#deps.invalidateAll();
			}
			toast.success('Conversation archived', {
				action: {
					label: 'Undo',
					handler: async () => {
						try {
							await setArchived(id, false);
							await this.#deps.invalidateAll();
							// Land the user back on the chat they were
							// viewing when they archived. If they were on
							// some other surface, leave them where they are.
							if (wasViewingChat) {
								await this.#deps.goto(`/chat/${id}`);
							}
						} catch (e) {
							toast.error(`Couldn't undo: ${e instanceof Error ? e.message : String(e)}`);
						}
					},
				},
			});
		} catch (e) {
			toast.error(`Couldn't archive conversation: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.busyId = null;
		}
	};

	/**
	 * The conversation overflow menu's Delete item calls this; it opens
	 * the shared <DeleteConversationDialog> (rendered by the layout).
	 * The dialog fetches the orphan-media counts, renders the confirm
	 * modal — with the "also delete N images" checkbox when there is
	 * media — and on confirm calls `performDelete` with the user's
	 * checkbox answer. The dialog only *asks*; performDelete owns the
	 * actual DELETE because the post-delete navigation here (bounce off
	 * /chat/:id) differs from the archived list's.
	 */
	requestDelete = (id: string): void => {
		// The sidebar is already pointer-events-none while busyId is
		// set; this guard is belt-and-suspenders against a stray click.
		if (this.busyId) return;
		this.deleteTargetId = id;
	};

	performDelete = async (id: string, deleteMedia: boolean): Promise<void> => {
		if (this.busyId) return;
		this.busyId = id;
		try {
			await deleteConversationApi(id, deleteMedia);
			if (this.#deps.getPathname() === `/chat/${id}`) {
				await this.#deps.goto('/', { invalidateAll: true });
			} else {
				await this.#deps.invalidateAll();
			}
		} catch (e) {
			toast.error(`Couldn't delete conversation: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.busyId = null;
		}
	};

	/**
	 * Open the inline rename input for the given conversation. We avoid
	 * optimistic-update gymnastics (mutating the load prop) — Enter
	 * fires the PATCH, closes the input, and invalidateAll() pulls the
	 * fresh title in. Esc / blur-without-change bail out silently.
	 */
	startRename = async (id: string, currentTitle: string | null): Promise<void> => {
		this.renamingId = id;
		this.renameOriginal = currentTitle ?? '';
		this.renameDraft = currentTitle ?? '';
		await tick();
		this.renameInputEl?.focus();
		this.renameInputEl?.select();
	};

	cancelRename = (): void => {
		this.renamingId = null;
		this.renameDraft = '';
		this.renameOriginal = '';
	};

	commitRename = async (): Promise<void> => {
		if (!this.renamingId) return;
		const id = this.renamingId;
		const decision = shouldCommitRename(this.renameDraft, this.renameOriginal);
		if (!decision.commit) {
			this.cancelRename();
			return;
		}
		// Optimistic-ish: close the input immediately so the UI feels
		// responsive even before the PATCH round-trip resolves. The
		// text shown in the sidebar reverts to the stale title until
		// invalidateAll() lands the new one — sub-300ms in practice.
		this.renamingId = null;
		this.renameDraft = '';
		this.renameOriginal = '';
		try {
			await renameConversationApi(id, decision.next);
			await this.#deps.invalidateAll();
		} catch (e) {
			toast.error(`Couldn't rename conversation: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	onRenameKey = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') {
			e.preventDefault();
			void this.commitRename();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.cancelRename();
		}
	};
}
