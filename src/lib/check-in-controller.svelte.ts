/**
 * The chat page's side of texting check-ins (see `check-ins.ts`): which one is
 * pending, cancelling it, and waking the page when it comes due.
 *
 * The server is the truth — the page load carries the pending row — but a
 * plain turn doesn't reload the page, so a reply that just streamed in is read
 * here the way the server read it (`checkInSetBy`), and the note shows at once.
 * The next load replaces that guess with the row itself.
 *
 * Waking: a check-in fires with nobody connected, so an open page wouldn't
 * otherwise notice. Once it's due the page reloads, which picks up the running
 * turn as a recovered one (and that polls until the reply lands). The runner
 * only ticks every 30s, so a reload that still finds it pending tries again.
 */
import { refreshAll } from '$app/navigation';
import { errorMessageFromResponse } from './fetch-error';
import { checkInSetBy } from './texting-check-ins';
import type { ChatMessage, PendingCheckIn } from './types/api';

/** After the due time, before the first reload: the runner's tick, plus a beat. */
const FIRST_WAKE_DELAY_MS = 5_000;
const RETRY_WAKE_MS = 30_000;

export class CheckInController {
	// `.raw` — only ever assigned whole.
	pending = $state.raw<PendingCheckIn | null>(null);
	#convId: () => string;

	constructor(deps: { convId: () => string }, seed: PendingCheckIn | null) {
		this.#convId = deps.convId;
		this.pending = seed;
	}

	/** The page load's row — the truth, whatever was guessed before it. */
	syncFromServer(seed: PendingCheckIn | null): void {
		this.pending = seed;
	}

	/** A reply just finished streaming: it replaces the pending check-in with
	 *  whatever it sets, as it did on the server. */
	noteReply(messages: ChatMessage[], replyId: string): void {
		const reply = messages.find((m) => m.id === replyId);
		if (!reply) return;
		const marker = checkInSetBy(messages, replyId);
		this.pending = marker
			? { sourceMessageId: replyId, fireAt: reply.createdAt + marker.delayMs, note: marker.note }
			: null;
	}

	async cancel(): Promise<void> {
		const before = this.pending;
		this.pending = null;
		const res = await fetch(`/api/conversations/${this.#convId()}/check-in`, {
			method: 'DELETE',
		});
		if (!res.ok) {
			this.pending = before;
			throw new Error(await errorMessageFromResponse(res));
		}
	}

	/**
	 * Reload the page once `checkIn` is due, and again while it stays pending.
	 * Returns a cleanup for the caller's `$effect`, which re-runs it whenever the
	 * pending row changes (a reload that brings a new one included).
	 */
	wakeWhenDue(checkIn: PendingCheckIn, now = Date.now()): () => void {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const arm = (delay: number) => {
			timer = setTimeout(() => {
				// Hidden: nothing to draw. The next try after it shows again does it.
				if (globalThis.document?.visibilityState !== 'hidden') void refreshAll();
				arm(RETRY_WAKE_MS);
			}, delay);
		};
		arm(Math.max(0, checkIn.fireAt - now) + FIRST_WAKE_DELAY_MS);
		return () => {
			if (timer) clearTimeout(timer);
		};
	}
}
