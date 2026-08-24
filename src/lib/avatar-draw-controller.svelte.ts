/**
 * Avatar-draw recovery controller — the client half of "the portrait becomes
 * this conversation's face".
 *
 * The server applies the avatar itself, in the relay, so the portrait is never
 * lost to a dead connection (see the generate route). What still needs a live
 * client is knowing whether a draw is running and saying so: the progress ring,
 * and pulling the result into view once it lands. That is all this owns.
 *
 * Extracted from the chat page for the same reason `ChatTurnController` and
 * `FanoutController` were — the page is a thin host and this is unit-testable in
 * isolation — but with a sharper motive. Four rounds of review found bugs in
 * this state machine while it lived inline, three of them regressions from the
 * previous round's fix, and none of them could have been caught by a test,
 * because inline in a page component there was nothing to instantiate. The
 * scenarios in `tests/unit/avatar-draw-controller.test.ts` are those exact bugs.
 *
 * WHY A DRAW ISN'T A TURN. `ChatTurnController` gets to keep two plain booleans
 * for its interruption latches, reset at the top of every `send()`, because
 * `busy` serializes turns page-wide: "the current turn" is never ambiguous. A
 * draw deliberately leaves the composer usable — that's the point of
 * backgrounding it — so draws in different conversations genuinely overlap, and
 * every flag here has to carry WHICH conversation it belongs to. Every clear is
 * ownership-tested for the same reason.
 *
 * The three flags, and why they can't be one:
 *
 *   `#interruptedFor` — "this conversation's draw lost its connection to an
 *   OUTSIDE cause": the page went hidden, or went offline. Consulted for a
 *   decision in exactly one place, `wasInterrupted`, which the page's draw uses
 *   to choose whether the probe gets a fallback message. Deliberately NOT
 *   cleared on the way back to the foreground: that would race the killed
 *   fetch's rejection, which is the whole reason it exists. The cost of that
 *   coarseness is that a single tab switch leaves it set for the rest of a long
 *   draw, which is why a failure the SERVER reported overrides it (see
 *   `reportFailure`).
 *
 *   `#owedFor` — "this conversation is still owed a reconcile". Cleared by a
 *   probe that actually got an answer, or by a draw running to completion —
 *   never merely by attempting a probe. An interruption's first probe often
 *   fails because the network hasn't really come back, and a debt cleared on
 *   attempt leaves nothing for the next resume to retry, while the poll can't
 *   step in either: what arms the poll is the mirror only a successful probe can
 *   seed. The draw then finishes server-side against a page still showing the
 *   old face.
 *
 *   `#probingFor` — a probe is already in flight. Collapses the several callers
 *   that can fire on one resume (the visibility handler, the draw's own catch, a
 *   poll tick) into one request and at most one reload.
 *
 * Plain fields, not `$state`, for all three: nothing renders from them. Only
 * `#draw` and `#serverSince` feed the UI.
 */

import { invalidateAll } from '$app/navigation';
import { toast } from './toast.svelte';

/** Everything the controller needs from the host page. A getter, so the read is
 *  fresh and reactive — the page reassigns `convId` on an in-place navigation. */
export interface AvatarDrawDeps {
	/** The conversation currently on screen. */
	convId(): string;
}

/** How often a recovered draw's poll re-probes. Matches the turn and fan-out
 *  recovery polls; the probe is cheap enough that the interval is the cost. */
const POLL_MS = 4000;

export class AvatarDrawController {
	/**
	 * The conversation-on-screen getter, held directly and given a placeholder
	 * rather than being read off a stored deps object.
	 *
	 * `recovered` below is a `$derived` CLASS FIELD, and class-field initializers
	 * run before the constructor body — so an initializer referencing a field the
	 * constructor assigns is "used before initialization". It happens to work,
	 * because a derived doesn't evaluate until something reads it, but relying on
	 * that is exactly the kind of load-bearing subtlety that should be visible
	 * rather than inferred. An initialized field makes the ordering true instead
	 * of merely lazily true, and keeps `pnpm check` at zero.
	 */
	#convId: () => string = () => '';

	/**
	 * The draw this client is driving, or null. Scoped to its conversation, not a
	 * bare status string: the chat page component is REUSED across
	 * /chat/[a] → /chat/[b], so a draw started in A is still running with its
	 * closure intact after the user switches to B. Deriving against the current
	 * conversation means B shows nothing and A shows its progress again on
	 * return, without the switch teardown having to null it — which would race
	 * the old closure's own writes.
	 */
	#draw = $state<{ conversationId: string; status: string } | null>(null);

	/**
	 * Server truth for a draw this client ISN'T driving: its fetch died (iOS
	 * suspended the PWA mid-draw) but the drawing didn't. Seeded from the page
	 * load and by a probe that finds a draw running. Kept apart from the turn
	 * controller's `serverInFlightSince`, which is turn-scoped and deliberately
	 * blind to this — see `getInFlightSince` for why a draw must stay invisible
	 * to the turn machinery.
	 */
	#serverSince = $state<number | null>(null);

	#interruptedFor: string | null = null;
	#owedFor: string | null = null;
	#probingFor: string | null = null;

	constructor(deps: AvatarDrawDeps, serverDrawSince: number | null) {
		// Wrapped rather than assigned bare: pulling a method off its object loses
		// the `this` it might have wanted (`unbound-method`). The page passes an
		// arrow closing over its own `$state`, so this is belt-and-braces — but the
		// deps contract doesn't promise that, and a future caller passing a real
		// method shouldn't silently break.
		this.#convId = () => deps.convId();
		this.#serverSince = serverDrawSince;
	}

	// --- what the page renders -------------------------------------------

	/**
	 * 'Starting…' / 'Queued…' / 'Drawing…', or null when nothing is running for
	 * the conversation on screen.
	 *
	 * The server-truth fallback is what keeps a draw visible after iOS kills the
	 * connection — without it the ring vanishes the moment the fetch dies and the
	 * header claims nothing is happening for the several minutes the draw has
	 * left. It also gates the Draw action, so a non-null value here means the
	 * user can't start a second draw over the top of one already running.
	 */
	get status(): string | null {
		const draw = this.#draw;
		if (draw && draw.conversationId === this.#convId()) return draw.status;
		return this.#serverSince !== null ? 'Drawing…' : null;
	}

	/**
	 * A local closure is following a draw belonging to THE CONVERSATION ON SCREEN.
	 *
	 * Scoped for a sharper reason than symmetry with `status`: `#draw` survives a
	 * conversation switch on purpose, so an unscoped read stays true while the
	 * user stands in some other thread. Every hide would then latch, and every
	 * return to the foreground would reconcile — against the conversation they're
	 * standing in, which the draw cannot touch. The draw's own conversation is
	 * reconciled when they navigate back to it: that load carries
	 * `avatarDrawSince`, which is the same fact by a cheaper route.
	 */
	get localDraw(): boolean {
		return this.#draw?.conversationId === this.#convId();
	}

	/**
	 * A draw is running server-side that no local closure is following — the page
	 * arms its recovery poll on this.
	 *
	 * `$derived`, not a plain getter like its two neighbours, and the difference
	 * is load-bearing rather than stylistic. This is the only one of the three
	 * read inside an `$effect`, and a getter read there subscribes that effect to
	 * every source it touches — `#draw` included, which `setStatus` reassigns on
	 * every progress frame. The effect would then tear down and rebuild the poll's
	 * interval several times a second, restarting its window from zero, so a draw
	 * streaming in one conversation would starve the recovery poll of another:
	 * ring spinning, Draw disabled, and the probe that would clear both never
	 * firing. Memoizing here means the effect re-runs only when the BOOLEAN
	 * changes, which is all it cares about.
	 *
	 * `tests/component/AvatarDrawPollGating.test.ts` pins this with a real
	 * `$effect` subscriber under happy-dom; a plain getter fails it.
	 */
	readonly recovered: boolean = $derived(
		this.#serverSince !== null && this.#draw?.conversationId !== this.#convId(),
	);

	// --- the draw's own lifecycle ----------------------------------------

	/** Starting a draw for `cid`. Clears a latch left behind by a previous draw
	 *  whose fetch never settled to run its own teardown, so this one can't
	 *  inherit it. */
	begin(cid: string): void {
		if (this.#interruptedFor === cid) this.#interruptedFor = null;
	}

	/** Progress: 'Queued…', 'Drawing…'. */
	setStatus(cid: string, status: string): void {
		this.#draw = { conversationId: cid, status };
	}

	/**
	 * The stream ran to completion, so the server is done and there is nothing
	 * left for a later probe to discover.
	 *
	 * Discharging here matters because a hide arms the debt for ANY draw that was
	 * running when the page went away, without knowing whether the connection
	 * actually died — and on desktop it usually didn't, since a tab switch
	 * doesn't kill an SSE. Left set, the next return to the foreground probes,
	 * learns nothing, and pays a full branch reload for it.
	 *
	 * Called whether or not the user is still looking at `cid`: a draw finishing
	 * while they're elsewhere is exactly the case that would otherwise strand its
	 * debt with no reader able to discharge it.
	 */
	completed(cid: string): void {
		if (this.#owedFor === cid) this.#owedFor = null;
	}

	/** Whether an OUTSIDE cause (hidden / offline) took this draw's connection
	 *  away. The page's draw uses this to decide whether its failure message is
	 *  trustworthy enough to fall back on. */
	wasInterrupted(cid: string): boolean {
		return this.#interruptedFor === cid;
	}

	/**
	 * The draw's fetch or stream failed. Owe a reconcile and fire it.
	 *
	 * `failureMessage` should be omitted when the failure is explained by an
	 * interruption (see `wasInterrupted`) — but NOT when the server itself
	 * reported the failure, because a response physically arriving is proof that
	 * no interruption explains it. The page makes that call; it's the only party
	 * that knows where the throw came from.
	 */
	reportFailure(cid: string, failureMessage?: string): void {
		this.#owedFor = cid;
		void this.reconcile(cid, failureMessage);
	}

	/** The draw's closure is done, whichever way it went. Ownership-tested on
	 *  both: a newer draw may own these slots by now, and clearing them from
	 *  under it is how that one loses track of its own interruption. */
	end(cid: string): void {
		if (this.#draw?.conversationId === cid) this.#draw = null;
		if (this.#interruptedFor === cid) this.#interruptedFor = null;
	}

	// --- interruptions ----------------------------------------------------

	/** The page went hidden or offline. Arms both flags, but only for a draw this
	 *  client is actually following in the conversation on screen. */
	markInterrupted(): void {
		if (!this.localDraw) return;
		const cid = this.#convId();
		this.#interruptedFor = cid;
		this.#owedFor = cid;
	}

	/**
	 * Back in the foreground, or back online: reconcile if this conversation owes
	 * one. Returns true when a probe was issued, so the page can tell whether it
	 * still needs its own handling.
	 *
	 * Scoped to the conversation on screen rather than "any outstanding debt": a
	 * debt pointing at a conversation the user has left cannot be discharged from
	 * here — the probe's own scope checks would throw the answer away — so
	 * probing it is a request made to be discarded, on every focus, for as long
	 * as they stay away. That conversation reconciles the cheaper way when they
	 * return, from its load's `avatarDrawSince`.
	 *
	 * Neither flag is cleared here. The interruption latch is read by the draw's
	 * failure path, and iOS gives no ordering guarantee between this event and
	 * the killed fetch's rejection — clearing it here is how that path stops
	 * recognising its own interruption and surfaces a "Load failed" for a draw
	 * that is completing fine. The debt is cleared by a probe that got an answer,
	 * or by the draw completing.
	 */
	reconcileIfOwed(): boolean {
		const cid = this.#convId();
		if (this.#owedFor !== cid) return false;
		void this.reconcile(cid);
		return true;
	}

	// --- the probe --------------------------------------------------------

	/**
	 * Ask the server whether a draw is still running, and reconcile to the
	 * answer WITHOUT reloading the page unless there is something to reload for.
	 *
	 * `invalidateAll()` re-runs the chat route's load, which ships the entire
	 * active branch with `content_html` — the payload that load drops
	 * `await parent()` to keep off every refocus (measured 35 KB on a 40-turn
	 * thread, megabytes on a code-heavy one; see its header). A draw runs for
	 * minutes and the user is expected to go elsewhere during it, so paying that
	 * per return-to-foreground is the wrong trade: it re-downloads a conversation
	 * that by construction cannot have changed, because the thing we're waiting
	 * on hasn't finished.
	 *
	 * The branch-walk-free `?fanout=1` variant answers the only question that
	 * matters. Still running: seed the mirror, which restores the ring and arms
	 * the poll, at no further cost. Finished: one reload.
	 *
	 * Every caller routes through here — the interruption handlers, the draw's
	 * own failure path, and each poll tick — so the in-flight guard is what keeps
	 * a single resume from costing several probes and several reloads.
	 *
	 * `failureMessage` is reported once the probe CONFIRMS the draw is over, and
	 * also on any outcome that leaves us knowing nothing (the request threw, or
	 * the server answered but not with an answer). It must not be swallowed on a
	 * path where we've stopped looking, because it is a one-shot: the draw's
	 * failure path is the only caller that supplies one and every retry passes
	 * none. It IS dropped where dropping it is the point — both
	 * conversation-switch exits, and the still-running branch.
	 */
	async reconcile(cid: string, failureMessage?: string): Promise<void> {
		if (this.#probingFor === cid) return;
		this.#probingFor = cid;
		// Set once the message has been shown, so the paths below can't show it
		// twice — `invalidateAll()` rejecting after a toast would otherwise fall
		// into the catch and repeat it.
		let reported = false;
		try {
			const res = await fetch(`/api/conversations/${cid}?fanout=1`);
			if (this.#convId() !== cid) return;
			if (!res.ok) {
				// Reached the server and learned nothing — epistemically the same
				// position as not reaching it at all, so report the same way rather
				// than returning in silence, which would lose the message for good.
				//
				// The debt and the mirror are deliberately left alone: a non-2xx says
				// nothing about the draw either way. That does mean a PERSISTENT
				// non-2xx (conversation deleted elsewhere → 404, session expired
				// mid-draw → 401) still leaves the poll without a terminating answer,
				// so the ring spins and `status` keeps the Draw action disabled. That's
				// a separate problem and silence here would not have helped it.
				if (failureMessage) toast.error(failureMessage);
				return;
			}
			const body = (await res.json()) as { avatarDrawSince: number | null };
			if (this.#convId() !== cid) return;
			// Answered — the debt is discharged whichever way it went.
			if (this.#owedFor === cid) this.#owedFor = null;
			if (body.avatarDrawSince === null) {
				if (failureMessage) {
					toast.error(failureMessage);
					reported = true;
				}
				await invalidateAll();
			} else {
				this.#serverSince = body.avatarDrawSince;
			}
		} catch {
			// Either the request itself failed — most often because the network
			// hasn't actually come back yet — or the reload after a confirmed answer
			// did. In the first case the debt is deliberately still set, so the next
			// resume tries again; in the second it's already discharged and the
			// mirror is still set, so the poll retries the reload instead.
			if (failureMessage && !reported && this.#convId() === cid) {
				toast.error(failureMessage);
			}
		} finally {
			if (this.#probingFor === cid) this.#probingFor = null;
		}
	}

	/**
	 * Poll while a draw runs that this client isn't driving. Returns a cleanup fn
	 * for the caller's `$effect`, matching the turn and fan-out controllers.
	 *
	 * Each tick is the same probe the interruption handlers use, which is what
	 * makes a tick overlapping one of them cost a single request rather than two
	 * reloads. Termination is the caller's effect gate: a probe that finds the
	 * draw finished reloads, the reload nulls the mirror, `recovered` goes false
	 * and the effect tears this down. Deliberately NOT a self-managed stop flag —
	 * the obvious shape clears its own interval BEFORE awaiting the reload, so a
	 * reload that rejects leaves the ring spinning with nothing left to re-arm it,
	 * and `status` gates the Draw action, so the feature stays disabled until the
	 * user navigates away. Here a rejected reload just leaves the mirror set and
	 * the next tick retries.
	 */
	startRecoveryPoll(): () => void {
		const cid = this.#convId();
		const interval = setInterval(() => void this.reconcile(cid), POLL_MS);
		return () => clearInterval(interval);
	}

	/** Mirror the load's `avatarDrawSince`. The page calls this on a genuine
	 *  page-data change; a layout-only invalidation leaves it alone, and its
	 *  `data.avatarDrawSince` is equally stale, so nothing is lost. */
	syncFromServer(serverDrawSince: number | null): void {
		this.#serverSince = serverDrawSince;
	}

	/** Test-only reads of the otherwise-private latches, so a test can assert on
	 *  the debt's lifetime — the thing three of four review rounds got wrong —
	 *  rather than only on its downstream effects. */
	get debug(): {
		interruptedFor: string | null;
		owedFor: string | null;
		probingFor: string | null;
	} {
		return {
			interruptedFor: this.#interruptedFor,
			owedFor: this.#owedFor,
			probingFor: this.#probingFor,
		};
	}
}
