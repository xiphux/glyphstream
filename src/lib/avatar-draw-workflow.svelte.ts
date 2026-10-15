/**
 * The avatar draw dialog's workflow: which reply the portrait is drawn from,
 * which image model draws it, the dialog's editable prompt, the compare cart,
 * and the draw itself (one model in the background, or several as a fan-out
 * comparison).
 *
 * Lifted out of the chat page, which hosts it. The recovery half (the ring,
 * the interruption latches, the reconcile) is `AvatarDrawController`; this is
 * the half that starts a draw, and it reports progress through that controller.
 */
import { refreshAll } from '$app/navigation';
import { lastReplyMessage } from './chat-render.js';
import { consumeChatStream } from './consume-chat-stream.js';
import { errorMessageFromResponse } from './fetch-error.js';
import { expandCompareSelections, type CompareSelection } from './fanout.js';
import { partsToText } from './message-parts.js';
import { extractAvatarPrompt } from './avatar-prompt.js';
import { toast } from './toast.svelte.js';
import type { AvatarDrawController } from './avatar-draw-controller.svelte.js';
import type { FanoutController } from './fanout-controller.svelte.js';
import type { ModelCatalogue } from './model-catalogue.svelte.js';
import type { ChatMessage } from './types/api.js';

/** What the workflow reads from the host page. Getters, so each read is fresh:
 *  the page reassigns `convId` and `messages` on an in-place navigation. */
export interface AvatarDrawWorkflowDeps {
	/** The conversation currently on screen. */
	convId(): string;
	/** The active branch. */
	messages(): ChatMessage[];
	catalogue: ModelCatalogue;
	/** The user's saved avatar model, if any. */
	savedModelId(): string | null | undefined;
	/** Whether prompt enhancement starts on when the dialog opens. */
	enhanceByDefault(): boolean;
	draw: AvatarDrawController;
	fanout: FanoutController;
}

export class AvatarDrawWorkflow {
	#deps: AvatarDrawWorkflowDeps;

	/** The dialog is up. */
	open = $state(false);
	/**
	 * The dialog's editable prompt. Seeded from the source reply when the dialog
	 * opens, then owned by the user — a model that answers in character before
	 * complying leaves prose to trim, and `extractAvatarPrompt` only removes what
	 * it can identify.
	 */
	prompt = $state('');
	/**
	 * Seeded from the conversation's own setting each time the dialog opens, so
	 * it starts where the rest of the app would put it — but it's the only place
	 * the choice is reachable at all, since the feature toggle is kind-scoped to
	 * image conversations and this is a chat one.
	 */
	enhance = $state(true);
	/**
	 * Picking several image models turns the draw into a comparison: a branch per
	 * model, resolved in the fan-out grid. Kept here (not dialog state) because
	 * the dispatch reads it after the dialog has closed.
	 */
	compareSelections = $state<CompareSelection[]>([]);
	compareMode = $state(false);
	#modelOverride = $state<string | null>(null);

	/** The image models this user can draw with. */
	readonly imageModels = $derived.by(() =>
		this.#deps.catalogue.all.filter((m) => m.kind === 'image'),
	);

	/**
	 * The model they'll draw with now: their saved choice if it still resolves,
	 * else the first available. Re-saved on change (`setModel`), so picking is a
	 * one-time cost.
	 */
	readonly modelId = $derived.by(() => {
		if (this.#modelOverride) return this.#modelOverride;
		const saved = this.#deps.savedModelId();
		if (saved && this.imageModels.some((m) => m.id === saved)) return saved;
		// A saved choice we cannot see YET is not a saved choice we can override.
		// `openDialog` fires `ensureAll()` and opens in the same tick, so until it
		// lands `imageModels` holds only the image models in the first-paint slice —
		// substituting one of those would arm Draw on a model the user never picked,
		// and a click inside that window would generate on it. Empty disables Draw
		// (see generate's guard) for the moment it takes to resolve.
		//
		// Keyed on the load being in flight, NOT on `membership(saved) !== 'no'`: that
		// stays true forever for a saved model whose endpoint is down, and true even
		// once the catalogue is loaded and has simply reclassified the model as
		// non-image — both of which would leave Draw permanently disabled with no
		// fallback, where the old code offered the first available image model.
		if (saved && this.#deps.catalogue.status === 'loading') return '';
		return this.imageModels[0]?.id ?? '';
	});

	/**
	 * The reply the portrait gets drawn from: the most recent assistant message
	 * with text. Right after step 1 that IS the description, which is the whole
	 * sequence — but nothing forces it, so any reply you like can be the source.
	 */
	readonly sourceMessage = $derived.by(() =>
		[...this.#deps.messages()]
			.reverse()
			.find((m) => m.role === 'assistant' && partsToText(m.parts).trim()),
	);

	/**
	 * Whether this description has already been drawn on the active branch. A
	 * second generation appends another portrait under the SAME description, so
	 * the variants land as siblings and the ‹N/M› arrows compare them for free —
	 * nothing about re-rolling needed building, only saying.
	 */
	readonly alreadyDrawn = $derived.by(() => {
		const source = this.sourceMessage;
		return (
			!!source &&
			this.#deps
				.messages()
				.some((m) => m.parentMessageId === source.id && m.parts.some((p) => p.type === 'image'))
		);
	});

	readonly #compareBranches = $derived.by(() =>
		expandCompareSelections(this.compareSelections, (id) => {
			const m = this.imageModels.find((x) => x.id === id);
			return m ? { displayName: m.displayName, modelKind: m.kind } : undefined;
		}),
	);
	readonly #comparing = $derived(this.compareMode && this.#compareBranches.length >= 2);

	/**
	 * Whether a comparison may be offered for this description.
	 *
	 * A comparison parks itself on the description so it can be rebuilt after a
	 * reload, which means the active leaf has to end up there. It already is right
	 * after a description arrives; for a re-roll it sits on the portrait drawn
	 * last, and stepping back onto its parent hides nothing (that portrait
	 * reappears as a grid column). Once the conversation has continued past the
	 * description, those turns hang off one particular portrait and picking a
	 * different one would strand them.
	 *
	 * `messages` is the active branch, so its last entry IS the leaf. The server
	 * re-decides this properly (it can see children on branches this list doesn't
	 * contain) and 409s; this is the affordance, not the rule.
	 */
	readonly canCompare = $derived.by(() => {
		const source = this.sourceMessage;
		// Past a reaction's tool row, matching the server's parkable rule — the two
		// must agree, or we offer a comparison the server then refuses.
		const leaf = lastReplyMessage(this.#deps.messages());
		if (!source || !leaf) return false;
		// The `assistant` conjunct mirrors the server's parkable rule exactly — see
		// avatar/prepare for why a childless USER leaf must not be parked over.
		// Kept in step deliberately: the dialog closes before prepare is called, so
		// a client that offered the comparison and a server that refuses it would
		// surface as a page-level error only after the user had picked their models.
		return (
			leaf.id === source.id || (leaf.role === 'assistant' && leaf.parentMessageId === source.id)
		);
	});

	constructor(deps: AvatarDrawWorkflowDeps) {
		this.#deps = deps;
	}

	openDialog(): void {
		const source = this.sourceMessage;
		if (!source) return;
		// The dialog renders a model list and picks a default from it, and the
		// catalogue holds neither by default. Fire-and-forget: the dialog is a static
		// import so it opens on the tap regardless, and its picker fills in when this
		// resolves — `loading` is threaded through so the wait is visible.
		void this.#deps.catalogue.ensureAll();
		this.prompt = extractAvatarPrompt(partsToText(source.parts));
		this.enhance = this.#deps.enhanceByDefault();
		// A fresh cart every time. Carrying one over would make the next draw a
		// silent comparison — and, where `canCompare` has since gone false, one the
		// picker no longer shows any way to cancel.
		this.compareMode = false;
		this.compareSelections = [];
		this.open = true;
	}

	/**
	 * Close the dialog and drop its staged prompt, on a conversation switch: it
	 * was written against the conversation being left, and pressing Draw would
	 * send the old chat's text with the new chat's source message.
	 */
	reset(): void {
		this.open = false;
		this.prompt = '';
	}

	setModel(id: string): void {
		this.#modelOverride = id;
		// Persist as the new default. Fire-and-forget: failing to remember a
		// preference must not block the generation the user is about to run.
		void fetch('/api/user/preferences', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ avatarModelId: id }),
		}).catch(() => {});
	}

	/**
	 * Draw the same prompt with every model in the compare cart, one branch each,
	 * and resolve them in the fan-out grid.
	 *
	 * Nothing of the single-model path below applies: there's no ring to spin (the
	 * grid is the indicator), no interruption latch to arm (the fan-out controller
	 * has its own recovery, which is the same mechanism), and no result to
	 * announce — the portraits are candidates until one is picked.
	 */
	async #drawComparison(): Promise<void> {
		const source = this.sourceMessage;
		if (!source) return;
		const branches = this.#compareBranches;
		if (branches.length < 2) return;
		// Close first: past this point the grid reports progress, and a dialog left
		// up would sit on top of the thing the user is meant to be comparing. A
		// refusal from prepare surfaces as the page's error, not in the dialog.
		this.open = false;
		this.compareMode = false;
		this.compareSelections = [];
		await this.#deps.fanout.sendAvatarDraw({
			sourceMessageId: source.id,
			prompt: this.prompt,
			enhance: this.enhance,
			branches,
		});
	}

	/**
	 * Step two: draw the latest reply and make the result this conversation's
	 * avatar.
	 *
	 * Applying the portrait is the SERVER's job now (the relay's
	 * `onMediaPersisted` — see the generate route). This used to do it here on
	 * `done`, which meant the apply only happened for a draw the client survived;
	 * iOS suspends a PWA seconds after the screen locks, and a draw takes minutes,
	 * so the common case was the portrait landing with no avatar to show for it.
	 * What's left here is the part that genuinely needs a live client: the
	 * progress ring, and pulling the result into view.
	 */
	async generate(): Promise<void> {
		// Two or more models is a comparison, which is a different mechanism end to
		// end — see #drawComparison. One is the background draw below.
		if (this.#comparing) {
			await this.#drawComparison();
			return;
		}
		const avatarDraw = this.#deps.draw;
		const source = this.sourceMessage;
		if (!source || !this.modelId || avatarDraw.status) return;
		// Snapshot the conversation ONCE. Everything below runs across awaits that
		// span the whole generation, and `convId` is reassigned when the user
		// navigates to another chat — reading it again afterwards is how A's
		// portrait ends up as B's avatar.
		const cid = this.#deps.convId();
		const setStatus = (status: string) => avatarDraw.setStatus(cid, status);
		setStatus('Starting…');
		// Whether the failure we end up in the catch with was one the SERVER told us
		// about, as opposed to the connection simply going away. The two are
		// indistinguishable by their exception — both are just an Error — but they
		// are entirely distinguishable by where they were raised, so record it at
		// the two places that know. See the catch for what it decides.
		let serverReported = false;
		avatarDraw.begin(cid);
		try {
			const res = await fetch(`/api/conversations/${cid}/avatar/generate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sourceMessageId: source.id,
					modelId: this.modelId,
					prompt: this.prompt,
					enhance: this.enhance,
				}),
			});
			// A rejection (bad model, message gone) lands here with the dialog still
			// up, so the prompt the user just edited survives to be retried.
			if (!res.ok || !res.body) {
				serverReported = true;
				throw new Error(await errorMessageFromResponse(res));
			}

			// Accepted — the request is the server's problem now, apply included. Close
			// and let the drawing finish in the background, reported on the header
			// avatar, so a minute of ComfyUI doesn't hold the UI hostage. Nothing
			// below this point is load-bearing: losing the connection costs the ring
			// and the toast, not the portrait or the avatar.
			this.open = false;

			// `drew` rather than a bare "the stream ended": a generation that
			// produced no image part applied no avatar either, so it must not be
			// announced as one.
			let drew: boolean | null = null;
			await consumeChatStream(res.body, {
				onQueued: (ahead, paused) => {
					const verb = paused ? 'Paused' : 'Queued';
					setStatus(ahead > 0 ? `${verb} — ${ahead} ahead…` : `${verb}…`);
				},
				onProgress: (_percent, statusText) => setStatus(statusText ?? 'Drawing…'),
				onStart: () => {
					setStatus('Drawing…');
				},
				onDone: ({ assistantMessage }) => {
					// The server has already applied it by the time `done` is written
					// (`onMediaPersisted` runs before the frame goes out), so there's
					// nothing to do here but notice.
					drew = assistantMessage.parts.some((p) => p.type === 'image');
				},
				onError: (message) => {
					// A terminal `error` frame: the server reached us to say the
					// generation failed, so no interruption can explain this away.
					serverReported = true;
					throw new Error(message);
				},
			});

			// The stream ran to completion, so the server is done and there is nothing
			// left for a later probe to discover. Discharging here matters because
			// the `hidden` handler arms the debt for ANY draw that was running when
			// the page went away, without knowing whether the connection actually
			// died — and on desktop it usually didn't (a tab switch doesn't kill an
			// SSE; the fan-out branch below leans on the same fact). Left set, the
			// next return to the foreground probes, learns nothing, and pays a full
			// branch reload for it.
			//
			// Ownership-guarded, and OUTSIDE the `convId === cid` block below: an
			// overlapping draw may own the slot by now, and a draw that finishes
			// while the user is elsewhere is exactly the case that would otherwise
			// strand its debt.
			avatarDraw.completed(cid);

			// Only refresh and announce if the user is still looking at the chat this
			// belongs to. Reloading a conversation they've moved on from — and
			// telling them its avatar changed — would be noise about someone else's
			// thread. Navigating back re-runs the load anyway.
			if (this.#deps.convId() === cid) {
				await refreshAll();
				if (drew) toast.success('Avatar updated');
			}
		} catch (e) {
			if (this.#deps.convId() !== cid) return;
			// Whether this was a real failure or only our connection dying is not
			// decidable here, so don't guess — ask the server. A killed fetch, a
			// refused one and a proxy that timed out a multi-minute SSE stream all
			// arrive as the same TypeError, and the last two carry no
			// `visibilitychange` or `offline` event to latch on. One cheap probe
			// settles it: the registry is the only party that knows.
			//
			// This is also why nothing here touches the controller's server-truth
			// mirror. Nulling it on the assumption that a failure freed the registry
			// entry is wrong for exactly the interruptions that don't latch, and it's
			// the write that stops `recovered` from ever flipping true — turning a
			// draw the poll would have recovered into the "failed toast, no avatar"
			// pair this whole change exists to remove.
			//
			// The interruption latch decides only ONE thing: whether to hand the probe
			// a message to fall back on. The probe reports it if it can't reach the
			// server either (see its docblock) — reasonable when we know nothing, and
			// wrong when we know an outside cause took the connection away, because
			// then the likeliest truth is that the draw is fine and we simply can't
			// see it. `hidden` and `offline` both fire BEFORE the rejection they cause,
			// so the latch is reliably set by the time we get here.
			//
			// But `serverReported` OVERRIDES it, because the latch is far coarser than
			// it looks: nothing clears it on the way back to the foreground (see the
			// visibility handler for why that would be worse), so one tab switch at
			// minute one of a five-minute draw leaves it set for the remaining four.
			// Without this override, a genuine upstream failure — ComfyUI running out
			// of memory, say — arriving any time in that window would be classified as
			// our own connection dropping, and the user would be told nothing. The
			// server having reached us to report the failure is proof that no
			// interruption explains it.
			const suppress = !serverReported && avatarDraw.wasInterrupted(cid);
			avatarDraw.reportFailure(
				cid,
				suppress ? undefined : e instanceof Error ? e.message : 'Avatar generation failed',
			);
		} finally {
			avatarDraw.end(cid);
		}
	}
}
