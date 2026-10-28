/**
 * The chat page's side of check-ins (see `check-ins.ts`): which one is
 * pending, cancelling it, and waking the page when it comes due.
 *
 * The server is the truth — the page load carries the pending row — but a
 * plain turn doesn't reload the page, so a reply that just streamed in is read
 * here the way the server read it (`checkInSetBy`), and the note shows at once.
 * The next load replaces that guess with the row itself.
 *
 * Waking: a check-in fires with nobody connected, so an open page wouldn't
 * otherwise notice. Once it's due the page asks the server (a cheap probe, not
 * a reload — the runner ticks every 30s and may wait longer still), and reloads
 * when the answer has moved: the check-in fired, which the reload picks up as a
 * recovered turn (and that polls until the reply lands), or it went away.
 */
import { refreshAll } from '$app/navigation';
import { errorMessageFromResponse } from './fetch-error';
import { graceFor } from './check-ins';
import { checkInSetBy } from './texting-check-ins';
import type { ChatMessage, CheckInStatus, PendingCheckIn } from './types/api';

/** After the due time, before the first probe: a beat, for the case where the
 *  runner's tick lands right on it. The retries cover the rest. */
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
		this.#set(seed);
	}

	/** Every load deserializes the row afresh, so an unchanged one keeps the
	 *  object it had: the page's wake-up effect re-arms on a new one, and a
	 *  reload every few seconds while overdue is what it would cost. */
	#set(next: PendingCheckIn | null): void {
		const cur = this.pending;
		if (
			cur &&
			next &&
			cur.sourceMessageId === next.sourceMessageId &&
			cur.fireAt === next.fireAt &&
			cur.note === next.note &&
			cur.createdAt === next.createdAt
		) {
			return;
		}
		this.pending = next;
	}

	/** A reply just finished streaming: it replaces the pending check-in with
	 *  whatever it sets, as it did on the server. */
	noteReply(messages: ChatMessage[], replyId: string): void {
		const reply = messages.find((m) => m.id === replyId);
		if (!reply) return;
		const marker = checkInSetBy(messages, replyId);
		this.#set(
			marker
				? {
						sourceMessageId: replyId,
						fireAt: reply.createdAt + marker.delayMs,
						note: marker.note,
						createdAt: reply.createdAt,
					}
				: null,
		);
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
	 * Once `checkIn` is due, probe for it every 30s and reload the page when it
	 * has fired or gone — but not past its grace period, when the runner has
	 * dropped it (or, with the feature switched off, never will): one last
	 * reload then, to clear it, and no more. Returns a cleanup for the caller's
	 * `$effect`, which re-runs it whenever the pending row changes.
	 */
	wakeWhenDue(checkIn: PendingCheckIn, now = Date.now()): () => void {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let stopped = false;
		const giveUpAt = checkIn.fireAt + graceFor(checkIn) + RETRY_WAKE_MS;
		const arm = (delay: number) => {
			timer = setTimeout(() => void wake(), delay);
		};
		const wake = async () => {
			if (Date.now() >= giveUpAt) return void refreshAll();
			// Hidden: nothing to draw. The next try after it shows again does it.
			if (globalThis.document?.visibilityState !== 'hidden' && (await this.#moved(checkIn))) {
				if (!stopped) void refreshAll();
				return;
			}
			if (!stopped) arm(RETRY_WAKE_MS);
		};
		arm(Math.max(0, checkIn.fireAt - now) + FIRST_WAKE_DELAY_MS);
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}

	/** Whether the server's answer differs from `checkIn` pending and idle. A
	 *  failed probe says yes: the reload is the fallback it was before. */
	async #moved(checkIn: PendingCheckIn): Promise<boolean> {
		try {
			const res = await fetch(`/api/conversations/${this.#convId()}/check-in`);
			if (!res.ok) return true;
			const status = (await res.json()) as CheckInStatus;
			return (
				status.inFlight ||
				status.checkIn?.sourceMessageId !== checkIn.sourceMessageId ||
				status.checkIn.fireAt !== checkIn.fireAt
			);
		} catch {
			return true;
		}
	}
}
