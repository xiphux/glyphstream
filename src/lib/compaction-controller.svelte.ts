/**
 * Conversation-compaction orchestration — summarize older history through the
 * conversation's own model so the thread keeps fitting in the context window.
 *
 * Three entry points share one piece of state and one set of preconditions:
 * the Compact button (manual), the just-in-time pass before a send
 * (`maybeAutoCompact`), and the undo affordance on the toast + the persisted
 * divider. Extracted from the chat page, which hosted all of it inline —
 * ~200 lines and six reactive declarations in a component that was already
 * carrying 29 `$effect`s. Mirrors chat-turn-controller.svelte.ts and
 * fanout-controller.svelte.ts: a `$state` class the page hosts, reaching shared
 * page state through injected deps rather than importing the page.
 *
 * Owns: the `compacting` latch, the streaming-summary buffer, and the three
 * flows. Deliberately does NOT own the post-compaction scroll-and-highlight —
 * that's a view concern needing the page's DOM ids and highlight state, so it
 * comes back out through `onCompacted`.
 *
 * The three flows share one precondition — not while a compaction, a turn, or a
 * parked fan-out comparison is live. Compaction advances the active leaf, which
 * resolves the parked fan-out (appendMessage nulls fanoutParentMessageId) and
 * would silently drop the compare grid; the sibling branches survive in the
 * tree, but the comparison view would be lost. Having it in one place is most of
 * why this is a class rather than three loose functions.
 */

import { tick } from 'svelte';
import { invalidateAll } from '$app/navigation';
import { compactionWorthwhile, isCompactionSummary, shouldAutoCompact } from './chat-compaction';
import { consumeChatStream } from './consume-chat-stream';
import { confirmDialog } from './confirm.svelte';
import { toast } from './toast.svelte';
import type { ChatMessage } from './types/api';

/**
 * Outcome of a compaction attempt, so the auto path can tell "freed up space /
 * nothing to free" (proceed) from "the summarization failed" (ask the user
 * before sending the full context). `error` carries the upstream message.
 */
export type CompactionOutcome =
	{ status: 'compacted' } | { status: 'noop' } | { status: 'error'; error: string };

/** Everything the controller needs from the host page. Getters for reactive
 *  reads; callbacks for the view work it must trigger but shouldn't own. */
export interface CompactionDeps {
	/** Current conversation id — read fresh for fetch URLs. */
	convId(): string;
	/** The rendered message list (the branch being compacted). */
	getMessages(): ChatMessage[];
	/** True while a turn is streaming — compaction must not race it. */
	turnBusy(): boolean;
	/** True while a fan-out comparison is parked (see the header note). */
	fanoutComparing(): boolean;
	/** The active model's context window, or null when unknown. Gates the
	 *  auto-compaction threshold check. */
	contextWindow(): number | null;
	/** The user's auto-compaction preference + threshold percentage. */
	autoCompactionEnabled(): boolean;
	autoCompactionThreshold(): number;
	/**
	 * A manual compaction landed. The page scrolls to the new summary and
	 * briefly highlights it — DOM work this controller has no business doing.
	 * Not called on the silent (auto) path.
	 */
	onCompacted(summaryMessageId: string): void | Promise<void>;
}

export class CompactionController {
	#deps: CompactionDeps;

	/** A compaction request is in flight (manual or auto). */
	compacting = $state(false);
	/** Gates the in-flight summary block; settles back to false once the
	 *  persisted collapsed divider lands (or on error/cancel). */
	streaming = $state(false);
	/** Live summary text while a compaction streams. */
	streamText = $state('');

	constructor(deps: CompactionDeps) {
		this.#deps = deps;
	}

	/**
	 * The shared precondition for all three flows. Kept private and consulted by
	 * each rather than duplicated — an early return that drifts between the three
	 * is exactly how a compaction would slip through during a parked fan-out.
	 */
	get #blocked(): boolean {
		return this.compacting || this.#deps.turnBusy() || this.#deps.fanoutComparing();
	}

	/**
	 * Whether the Compact button should be enabled.
	 *
	 * Gates on `compactionWorthwhile`, not just the structural "can this be
	 * compacted": compaction only shrinks history, so when the foldable history
	 * is tiny (the dominant cost being system prompt + tools + memories) the
	 * button stays disabled rather than running for ~no benefit.
	 */
	get compactable(): boolean {
		return !this.#blocked && compactionWorthwhile(this.#deps.getMessages());
	}

	/**
	 * The active-leaf compaction summary, if any — i.e. a summary with nothing
	 * sent after it, so it can still be undone. Drives the divider's restore
	 * control. Null once a later turn advances the leaf past it.
	 */
	get activeLeafSummaryId(): string | null {
		const messages = this.#deps.getMessages();
		const leaf = messages[messages.length - 1];
		return leaf && isCompactionSummary(leaf) ? leaf.id : null;
	}

	/**
	 * Run a compaction.
	 *
	 * `silent` (the auto path) suppresses ALL user-facing feedback — error toasts
	 * AND the success toast / scroll. The user never asked for an auto compaction
	 * and we immediately proceed to the message they actually sent, so yanking the
	 * view up to the new summary would be disorienting; a manual click, by
	 * contrast, gets confirmation + a scroll to where the summary landed. The auto
	 * path handles failure itself off the returned outcome instead.
	 */
	async compact(opts: { silent?: boolean } = {}): Promise<CompactionOutcome> {
		if (this.#blocked) return { status: 'noop' };
		this.compacting = true;
		this.streaming = false;
		this.streamText = '';
		let errored: string | null = null;
		let doneSummaryId: string | null = null;
		try {
			const res = await fetch(`/api/conversations/${this.#deps.convId()}/compact?stream=1`, {
				method: 'POST',
				headers: { Accept: 'text/event-stream' },
			});
			if (!res.ok || !res.body) {
				// 409 = nothing worth compacting yet — not a failure on the auto path.
				if (res.status === 409) {
					if (!opts.silent) toast.error('Not enough conversation history to compact yet.');
					return { status: 'noop' };
				}
				if (!opts.silent) toast.error("Couldn't compact this conversation.");
				return { status: 'error', error: "Couldn't reach the model to compact." };
			}
			await consumeChatStream(res.body, {
				onCompactionStart: () => {
					this.streaming = true;
				},
				onCompactionText: (chunk) => {
					this.streamText += chunk;
				},
				onCompactionDone: async (summaryMessage) => {
					doneSummaryId = summaryMessage.id;
					await invalidateAll();
				},
				onError: (msg) => {
					errored = msg;
				},
			});
			if (errored) {
				if (!opts.silent) toast.error(errored);
				return { status: 'error', error: errored };
			}
			if (doneSummaryId && !opts.silent) {
				// Confirm the (manual) action: it succeeded even though the token
				// number barely moves and the divider lands up-thread. The Undo action
				// covers an accidental tap — it's reversible while the summary is
				// still the leaf.
				toast.success('Conversation compacted', {
					action: { label: 'Undo', handler: () => void this.undo() },
				});
				await tick();
				await this.#deps.onCompacted(doneSummaryId);
			}
			return doneSummaryId ? { status: 'compacted' } : { status: 'noop' };
		} catch {
			if (!opts.silent) toast.error("Couldn't compact this conversation.");
			return { status: 'error', error: "Couldn't compact this conversation." };
		} finally {
			this.compacting = false;
			this.streaming = false;
			this.streamText = '';
		}
	}

	/**
	 * Undo the most recent compaction (the "Undo" toast action + the divider's
	 * restore control). Valid only while the summary is still the active leaf;
	 * the server 409s once a later turn has been sent. Reverts the leaf so the
	 * full history serializes again — the summary row stays in the tree.
	 */
	async undo(): Promise<void> {
		if (this.#blocked) return;
		let res: Response;
		try {
			res = await fetch(`/api/conversations/${this.#deps.convId()}/compact`, { method: 'DELETE' });
		} catch {
			toast.error("Couldn't undo the compaction.");
			return;
		}
		if (!res.ok) {
			// 409 = the summary is no longer the active leaf: either a later turn was
			// sent, or a prior undo already landed (e.g. its refresh failed and this
			// is a retry). Either way there's nothing to revert — stay neutral rather
			// than asserting a message was sent.
			toast.error(
				res.status === 409
					? 'Nothing to undo — the summary is no longer the latest message.'
					: "Couldn't undo the compaction.",
			);
			return;
		}
		// The server commits the revert before replying, so by here the undo has
		// durably succeeded. Report success independently of the view refresh: if
		// invalidateAll fails (a transient load re-fetch error), the undo still
		// happened — ask for a reload instead of falsely claiming it failed.
		try {
			await invalidateAll();
			toast.success('Compaction undone');
		} catch {
			toast.info('Compaction undone — reload to refresh the view.');
		}
	}

	/**
	 * Just-in-time auto-compaction, run right before a plain send: if the
	 * conversation has crossed the user's threshold of the model's window, compact
	 * first (streaming the summary for live feedback) so the next message
	 * continues with reclaimed space. Triggering here (vs. server-side mid-send)
	 * is what lets the summary stream instead of the send hanging on a spinner.
	 *
	 * Returns whether the caller should go ahead with the send. A success or a
	 * no-op (nothing worth compacting) → true. A *failure*, though, isn't silently
	 * swallowed: sending the full un-compacted context can push the conversation
	 * past the window, so we ask the user whether to send anyway or hold off and
	 * deal with it (e.g. retry, or compact manually) — false means they backed out.
	 */
	async maybeAutoCompact(): Promise<boolean> {
		if (!this.#deps.autoCompactionEnabled() || this.#blocked) return true;
		if (
			!shouldAutoCompact({
				branch: this.#deps.getMessages(),
				enabled: true,
				contextWindow: this.#deps.contextWindow(),
				threshold: this.#deps.autoCompactionThreshold(),
			})
		) {
			return true;
		}
		const result = await this.compact({ silent: true });
		if (result.status !== 'error') return true;
		return confirmDialog.ask({
			title: 'Context could not be compacted',
			message:
				`Automatic compaction failed: ${result.error} Send your message anyway with the ` +
				'full conversation? That may exceed the model’s context limit.',
			confirmLabel: 'Send anyway',
		});
	}
}
