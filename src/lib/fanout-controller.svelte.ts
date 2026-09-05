/**
 * Multi-model fan-out controller — the client-side orchestration for sending
 * one prompt to N branches (the cross product of picked models × split input
 * images), streaming each into its own compare column, and resolving the grid
 * (pick one / keep-many prune + regenerate). Extracted from the chat page so
 * the logic is unit-testable in isolation (instantiate with mock deps) and the
 * page stays a thin host: it owns the composer/picker bindings and a few effects
 * that delegate here.
 *
 * Owns: the columns + their per-branch state, the pick/dismiss/discard/
 * regenerate/stop actions, server-truth recovery (rebuild after a reload /
 * iOS-suspend), and the abort registry. Reaches shared page state (busy,
 * errorMsg, the message list, the per-turn model, the suspend/offline flags)
 * through the injected `FanoutDeps` rather than importing the page.
 */

import { tick } from 'svelte';
import { invalidateAll } from '$app/navigation';
import { isAbortError } from './abort';
import { appendReasoning, appendText } from './chat-render';
import { buildAvatarBranchBody, buildFanoutBranchBody } from './chat-send-body';
import { consumeChatStream } from './consume-chat-stream';
import {
	allColumnsSettled,
	collapseToCompareSelections,
	isMediaKind,
	MAX_FANOUT_BRANCHES_PER_CONVERSATION,
	nextDispatchIndex,
	rerollInsertIndex,
	type FanoutBranchSpec,
	type FanoutColumn,
	type FanoutModel,
} from './fanout';
import { errorMessageFromResponse } from './fetch-error';
import { clearTitlePending, markTitlePending } from './title-pending.svelte';
import type {
	ChatMessage,
	FanoutRecoveryState,
	MessagePart,
	ModelEntry,
	ModelKind,
	PrepareAvatarDrawRequest,
	PrepareAvatarDrawResponse,
	PrepareFanoutRequest,
	PrepareFanoutResponse,
} from './types/api';

/** Everything the controller needs from the host page. Getters for reactive
 *  reads; setters/callbacks for the shared state it must mutate. */
export interface FanoutDeps {
	/** Current conversation id — read fresh for fetch URLs + nav guards. */
	convId(): string;
	/** The aggregated model list, for column labels + recovery kind lookup. */
	models(): ModelEntry[];
	/** Message count, so a first-exchange fan-out can fire the title spinner. */
	messageCount(): number;
	/** The page's shared `busy` flag (gates recovery rebuilds). */
	busy(): boolean;
	/** Append the shared user message to the page's rendered list. */
	appendUserMessage(message: ChatMessage): void;
	setBusy(busy: boolean): void;
	setError(message: string | null): void;
	/** Promote the picker to the chosen branch's model (pick → continue). */
	setActiveModel(modelId: string, modelKind: ModelKind): void;
	setStreamedMessageId(id: string): void;
	/** True when a suspend/offline interruption happened during this turn. */
	interrupted(): boolean;
	/** Clear the suspend/offline flags (turn start + recovery handoff). */
	clearInterruptedFlags(): void;
	scrollToBottom(): void;
}

/** The reviewed prompt behind a live avatar comparison, as `sendAvatarDraw`
 *  captured it. See `FanoutController.#avatarDraw`. */
interface AvatarDrawHandle {
	sourceMessageId: string;
	prompt: string;
	enhance: boolean;
}

/** What a dispatch loop's branches ARE, snapshotted when the loop starts rather
 *  than read per branch — see `#dispatchColumns`. */
interface DispatchMode {
	mode: 'turn' | 'avatar';
	avatar: AvatarDrawHandle | null;
}

/** branchId prefix for the server-driven "Generating…" placeholder columns of a
 *  recovered fan-out. The builder and the recovery-poll gate both key off it. */
export const RECOVERED_PENDING_PREFIX = 'recovered-pending:';

interface PendingBranch {
	/** Model id, or '' when unknown (older payload → "Generating…" label). */
	modelId: string;
	/** 'queued' (waiting on the gate) vs 'streaming' (generating). */
	status: 'queued' | 'streaming';
	/** Generation start, for the timer; null while queued / unknown. */
	startedAt: number | null;
	/** Split-attachments input image, for the column's thumbnail; null when the
	 *  branch isn't editing/animating one (or the payload predates the field). */
	sourceMediaId: string | null;
}

/** Per-pending-branch descriptors (aligned with `pendingModelIds`/`pending`):
 *  each branch is QUEUED (no start time yet, waiting on the gate) or
 *  generating-with-a-timer (start time set). */
function pendingBranches(f: FanoutRecoveryState): PendingBranch[] {
	return f.pendingModelIds.map((modelId, i) => {
		const startedAt = f.pendingStartedAt[i] ?? null;
		return {
			modelId,
			status: startedAt !== null ? 'streaming' : 'queued',
			startedAt,
			sourceMediaId: f.pendingSourceMediaIds[i] ?? null,
		};
	});
}

export class FanoutController {
	#deps: FanoutDeps;

	/** Live + settled comparison columns. Non-empty == the compare view is up. */
	columns = $state<FanoutColumn[]>([]);
	/** A pick/dismiss/discard request is in flight. Re-rolls deliberately don't
	 *  take this lock — they're per-column + additive (see `regenerate`). */
	picking = $state(false);
	/** The anchor of the live/parked fan-out — discard/regenerate reparent new
	 *  branches to it. The shared user message for a turn fan-out; the appearance
	 *  description, an ASSISTANT message, for an avatar comparison. Null when no
	 *  comparison is active. (Name kept for the turn case it was written for.) */
	userMessageId = $state<string | null>(null);
	/** True while THIS client is driving the fan-out (owns the branch fetches).
	 *  False once recovered from server truth after a reload / disconnect, so the
	 *  rehydration may rebuild the grid. */
	live = $state(false);
	/** Per-branch abort controllers, keyed by column branchId, for Stop. */
	#aborts = new Map<string, AbortController>();
	/** Monotonic suffix for additive re-roll branchIds, so each new variation
	 *  column gets a stable, collision-free key for the grid's keyed `{#each}`. */
	#nextRerollSeq = 0;
	/**
	 * What the columns ARE: candidate replies to a shared user message (a turn
	 * fan-out), or candidate portraits for the conversation's face (an avatar
	 * comparison, anchored on the appearance description instead).
	 *
	 * One controller rather than two because everything between dispatch and
	 * resolution — streaming, stop, discard, the abort registry, server-truth
	 * recovery and its poll — is the same machinery. Only the dispatch endpoint
	 * and what a pick MEANS differ, and both read this.
	 */
	#mode = $state<'turn' | 'avatar'>('turn');
	/**
	 * The avatar draw's dispatch inputs, held for re-rolls.
	 *
	 * Null in turn mode, and also on a grid recovered from server truth: the
	 * prompt that drew these portraits was reviewed in the dialog and lives only
	 * in the page that dispatched them. The media row's `promptFull` is not a
	 * substitute — for an enhanced draw it holds what the ENHANCER wrote, so
	 * re-rolling from it would silently draw something else. So Regenerate is
	 * offered only while we still have the real prompt; see `canRegenerate`.
	 */
	#avatarDraw: AvatarDrawHandle | null = $state(null);

	comparing = $derived(this.columns.length > 0);
	streaming = $derived(this.columns.some((c) => c.status === 'queued' || c.status === 'streaming'));
	/**
	 * The subset of `streaming` where a branch has actually ACQUIRED its slot —
	 * `startedAt` is set only by `onStart` (and by recovery, from the registry's
	 * `generationStartedAt`), which is the gate handing over.
	 *
	 * Not `status === 'streaming'` alone: `onProgress` sets that status for the
	 * pre-slot "Enhancing prompt…" phase too, which runs BEFORE the gate and so
	 * would report a grid that hasn't reached the GPU as running on it. Feeds the
	 * sidebar's generating-vs-queued mark, where the whole question is which
	 * conversation holds the endpoint.
	 */
	generatingNow = $derived(
		this.columns.some((c) => c.status === 'streaming' && c.startedAt !== null),
	);
	columnsSettled = $derived(this.columns.length > 0 && allColumnsSettled(this.columns));
	/** Image/video fan-out is keep-many (prune + regenerate); chat is pick-one. */
	isMedia = $derived(this.columns.some((c) => isMediaKind(c.modelKind)));
	/** An avatar comparison: keep-many like any image grid, but ALSO pick-one —
	 *  the pick adopts a face rather than continuing the thread with that model. */
	isAvatar = $derived(this.#mode === 'avatar');
	/** Whether a re-roll can be dispatched. Always, for a turn fan-out (the server
	 *  re-derives the prompt from the shared user message); for an avatar grid only
	 *  while this page still holds the reviewed prompt — see `#avatarDraw`. */
	canRegenerate = $derived(this.#mode === 'turn' || this.#avatarDraw !== null);

	constructor(deps: FanoutDeps) {
		this.#deps = deps;
	}

	#modelDisplayName(modelId: string | null): string {
		if (!modelId) return 'Model';
		return this.#deps.models().find((m) => m.id === modelId)?.displayName ?? modelId;
	}

	/** Rebuild the compare grid from server-truth recovery state (persisted
	 *  branches + how many are still generating) — used on reload / disconnect
	 *  recovery, where the client's own branch fetches are gone. */
	#buildRecoveredColumns(
		siblings: ChatMessage[],
		pending: PendingBranch[],
		kind: ModelKind | null,
	): FanoutColumn[] {
		const models = this.#deps.models();
		const kindById = (id: string | null) => models.find((x) => x.id === id)?.kind ?? null;
		// The modality a persisted sibling actually IS, read from its parts — a
		// video/image part is ground truth even when the model id no longer
		// resolves in the current models() list (endpoint dropped from config, or
		// a renamed model). Falls through to the model lookup / fan-out kind below.
		const kindFromParts = (m: ChatMessage): ModelKind | null =>
			m.parts.some((p) => p.type === 'video')
				? 'video'
				: m.parts.some((p) => p.type === 'image')
					? 'image'
					: null;
		// Prefer the kind reported by the in-flight branches (so an all-pending
		// media recovery — long for video — renders the media grid immediately,
		// not a brief chat strip); fall back to a persisted sibling's own modality.
		const fallbackKind =
			kind ??
			(siblings.length > 0
				? (kindFromParts(siblings[0]) ?? kindById(siblings[0].modelUsed) ?? 'chat')
				: 'chat');
		const done: FanoutColumn[] = siblings.map((m) => {
			// A failed branch persisted as an error sibling (see the `error`
			// MessagePart): rebuild it as a settled error column so a fan-out
			// recovered after a disconnect shows the failure instead of dropping it.
			const errPart = m.parts.find(
				(p): p is Extract<MessagePart, { type: 'error' }> => p.type === 'error',
			);
			return {
				branchId: m.id,
				modelId: m.modelUsed ?? '',
				// Resolve the column's modality from the persisted parts first so a
				// recovered video renders as video even if its model id no longer
				// resolves; only then fall back to the model list / fan-out kind.
				modelKind: kindFromParts(m) ?? kindById(m.modelUsed) ?? fallbackKind,
				label: this.#modelDisplayName(m.modelUsed),
				segments: [],
				status: errPart ? 'error' : 'done',
				queuedAhead: 0,
				progress: null,
				statusLabel: null,
				startedAt: null,
				// Split-attachments provenance. For a result this comes off the output
				// media row; for a FAILED branch, off its error part (there is no
				// output) — either way the column keeps its input thumbnail.
				inputMediaId: m.sourceMediaId ?? null,
				// Read back off the row so a re-roll fired from a RECOVERED grid
				// inherits its source's grid position, exactly as a live one does.
				dispatchIndex: m.fanoutIndex ?? null,
				persisted: m,
				error: errPart?.message ?? null,
				errorMessageId: errPart ? m.id : null,
			};
		});
		const generating: FanoutColumn[] = pending.map((pb, i) => ({
			branchId: `${RECOVERED_PENDING_PREFIX}${i}`,
			modelId: pb.modelId,
			modelKind: kindById(pb.modelId) ?? fallbackKind,
			// Known model → label by its name (header reads like the live grid);
			// only fall back to "Generating…" when the model is genuinely unknown.
			label: pb.modelId ? this.#modelDisplayName(pb.modelId) : 'Generating…',
			segments: [],
			// Branch began generating → "Generating… {timer}"; still waiting on the
			// gate → QUEUED badge. Restores the live grid's per-branch state.
			status: pb.status,
			queuedAhead: 0,
			progress: null,
			statusLabel: null,
			startedAt: pb.startedAt,
			// The in-flight registry carries the branch's input image, so a grid
			// recovered mid-generation keeps the "this input → this model" pairing
			// instead of blanking the thumbnails until the branches land.
			inputMediaId: pb.sourceMediaId,
			// The in-flight registry doesn't carry the branch's grid position (it's
			// only a sort key for persisted rows), so a placeholder has none. They
			// already render after the settled columns; see #buildRecoveredColumns'
			// return.
			dispatchIndex: null,
			persisted: null,
			error: null,
			errorMessageId: null,
		}));
		return [...done, ...generating];
	}

	/**
	 * Fan one prompt out to N branches — the cross product of the picked models
	 * and the split input images (a branch is a model + optional input image).
	 * Creates the shared user message once (POST /prepare), then streams a
	 * sibling assistant response per branch into its own column. The active leaf
	 * stays pinned at the user message (server-side, advanceActiveLeaf:false) so
	 * every branch serializes the identical history and the unpicked siblings
	 * remain reachable; picking a column promotes it to the active thread.
	 *
	 * `models` is the picked cart *before* the split cross-product, passed
	 * separately because it can't be recovered from `branches` (splitting repeats
	 * each model once per input image). /prepare records it on the user message as
	 * the durable provenance the reuse-prompt action reads.
	 */
	async send(
		text: string,
		attachedMediaIds: string[],
		branches: FanoutBranchSpec[],
		models: readonly FanoutModel[],
	): Promise<void> {
		// Mirror the server's per-conversation cap so a legitimate user who builds
		// an oversized cross-product (models × split images) gets a friendly message
		// up front instead of a mid-fan-out 429 on the branch dispatch.
		if (branches.length > MAX_FANOUT_BRANCHES_PER_CONVERSATION) {
			this.#deps.setError(
				`Too many variations: ${branches.length} exceeds the limit of ${MAX_FANOUT_BRANCHES_PER_CONVERSATION}. Reduce the number of models or split images.`,
			);
			return;
		}
		const turnConvId = this.#deps.convId();
		const isFirstExchange = this.#deps.messageCount() === 0;
		// Claim the mode, don't assume it. The controller outlives any one
		// comparison, and a resolved avatar grid leaves `#mode` where it was — so
		// without this, the first ordinary fan-out after one would post its branches
		// to the avatar route. Set at every entry point rather than cleared at every
		// exit, so a new exit can't quietly reintroduce it.
		this.#mode = 'turn';
		this.#avatarDraw = null;
		this.#deps.setBusy(true);
		this.#deps.setError(null);
		// Clear the suspend/offline flags for this turn (mirrors ChatTurnController.send()).
		// Without this a stale flag from a prior backgrounded turn would make
		// runBranch misclassify a genuine branch failure as "Generating…".
		this.#deps.clearInterruptedFlags();

		// 1. Create the shared user message (no dispatch).
		let userMessage: ChatMessage;
		try {
			const res = await fetch(`/api/conversations/${turnConvId}/messages/prepare`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					text,
					attachedMediaIds,
					models: collapseToCompareSelections(models),
				} satisfies PrepareFanoutRequest),
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			userMessage = ((await res.json()) as PrepareFanoutResponse).userMessage;
		} catch (e) {
			if (this.#deps.convId() === turnConvId) {
				this.#deps.setError(e instanceof Error ? e.message : String(e));
			}
			this.#deps.setBusy(false);
			return;
		}
		if (this.#deps.convId() !== turnConvId) {
			this.#deps.setBusy(false);
			return;
		}

		// 2. Render the user message and spin up the columns.
		this.#deps.appendUserMessage(userMessage);
		this.userMessageId = userMessage.id;
		// This client owns the fan-out — block the server-truth rehydration from
		// clobbering the live grid until we disconnect / hand off.
		this.live = true;
		if (isFirstExchange) markTitlePending(turnConvId);
		this.columns = branches.map((b, i) => ({
			branchId: `${userMessage.id}:${i}`,
			dispatchIndex: i,
			modelId: b.modelId,
			modelKind: b.modelKind,
			label: b.displayName,
			segments: [],
			status: 'queued' as const,
			queuedAhead: 0,
			progress: null,
			statusLabel: null,
			startedAt: null,
			inputMediaId: b.inputMediaId,
			persisted: null,
			error: null,
			errorMessageId: null,
		}));
		await tick();
		this.#deps.scrollToBottom();
		// The compare view keeps the composer disabled until the user picks; the
		// per-turn `busy` flag can release.
		this.#deps.setBusy(false);

		// 3. Stream every branch (see #dispatchColumns for the ordering).
		try {
			await this.#dispatchColumns(turnConvId, userMessage.id, this.columns);
		} finally {
			// Clear the first-exchange title spinner regardless of whether the
			// user has since navigated away — the flag is module-level.
			if (isFirstExchange) clearTitlePending(turnConvId);
		}
		if (this.#deps.convId() !== turnConvId) return;

		// 4. Resolve the outcome. If the user Stopped, leave the settled columns
		//    as-is for manual pick/dismiss. Otherwise:
		//    - 0 survivors → drop the columns + keep the prompt to edit/resend.
		//    - media (image/video, keep-many) → keep the grid for ANY survivors so
		//      the user can prune duds / regenerate; the parked-fan-out marker lets
		//      a reload (even down to one kept variation) rehydrate it.
		//    - chat with one survivor → promote it; 2+ → keep the grid for the pick.
		// If a suspend/disconnect handed this fan-out off to recovery mid-flight
		// (live cleared), the recovery flow owns resolution now — don't let the
		// live path auto-promote a survivor from a grid it no longer drives.
		if (!this.live) return;
		if (this.columns.some((c) => c.status === 'cancelled')) return;
		const survivors = this.columns.filter((c) => c.persisted);
		if (survivors.length === 0) {
			this.columns = [];
			this.userMessageId = null;
			this.live = false;
			this.#deps.setError('No model responded. Edit your message and try again.');
			// Guard the refetch like pick/dismiss do — errorMsg is already set.
			try {
				await invalidateAll();
			} catch {
				// Best-effort re-sync; the error is already surfaced above.
			}
			return;
		}
		if (branches[0]?.modelKind === 'chat' && survivors.length === 1) {
			await this.pick(survivors[0]);
		}
	}

	/**
	 * Dispatch `cols` in selection order, awaiting each branch reaching the
	 * endpoint gate (its first SSE event) before firing the next, so they enqueue
	 * in the order the user picked rather than racing — the N branch POSTs are
	 * independent requests, and without sequencing whichever reaches
	 * `acquireEndpointSlot` first wins the line. Granted branches stream in the
	 * background while the rest dispatch, so this only orders the sub-millisecond
	 * enqueue, not the generation.
	 *
	 * Takes the columns explicitly rather than reading `this.columns`: an avatar
	 * grid is seeded with the portraits already drawn from this description, and
	 * those are results, not branches to dispatch.
	 */
	async #dispatchColumns(
		turnConvId: string,
		parentMessageId: string,
		cols: readonly FanoutColumn[],
	): Promise<void> {
		// Snapshot what these branches ARE, once, instead of letting each read the
		// live fields. The loop dispatches one at a time — each waits for the prior
		// to reach the endpoint gate — and a conversation switch runs `teardown()`
		// in that gap, which resets `#mode`/`#avatarDraw`. Read fresh, a
		// not-yet-dispatched avatar branch would build a TURN body against its
		// assistant anchor, which /messages refuses with a 400; and nobody would
		// ever see it, because the resolution below has already bailed on the
		// conversation change. The user would just get fewer candidates than they
		// asked for, silently.
		//
		// Aborting doesn't save us either: `markEnqueued` is in `#runBranch`'s
		// `finally` precisely so a branch that dies before its first event still
		// releases the sequence — so `teardown()`'s aborts ADVANCE this loop rather
		// than stopping it.
		const dispatch: DispatchMode = { mode: this.#mode, avatar: this.#avatarDraw };
		const branchRuns: Array<Promise<ChatMessage | null>> = [];
		for (const col of cols) {
			let signalEnqueued!: () => void;
			const enqueued = new Promise<void>((resolve) => {
				signalEnqueued = resolve;
			});
			branchRuns.push(
				this.#runBranch(turnConvId, parentMessageId, col, {
					onEnqueued: signalEnqueued,
					fanoutSize: cols.length,
					dispatch,
				}),
			);
			await enqueued;
		}
		await Promise.all(branchRuns);
	}

	/**
	 * Fan an avatar draw out to N image models: one candidate portrait per branch,
	 * all hanging off the appearance description, compared in the same grid every
	 * other fan-out uses.
	 *
	 * `../avatar/prepare` stands in for `/messages/prepare`: there's no user
	 * message to create (the description is the anchor and already exists), but
	 * the fan-out marker still has to be parked once before any branch, and it
	 * returns the portraits already drawn from this description. Those are seeded
	 * as settled columns, so a re-roll compares the new models against what you
	 * already had — and so the live grid matches what the server-truth rebuild
	 * produces after a reload, which is every assistant child of the anchor.
	 *
	 * The single-model draw does NOT come through here. It stays a background side
	 * errand that applies its own result server-side (see the generate route);
	 * asking for a second model is what turns the draw into a decision.
	 */
	async sendAvatarDraw(input: {
		sourceMessageId: string;
		/** The reviewed prompt from the draw dialog, not the anchor's raw text. */
		prompt: string;
		enhance: boolean;
		branches: readonly FanoutModel[];
	}): Promise<void> {
		if (input.branches.length > MAX_FANOUT_BRANCHES_PER_CONVERSATION) {
			this.#deps.setError(
				`Too many variations: ${input.branches.length} exceeds the limit of ${MAX_FANOUT_BRANCHES_PER_CONVERSATION}. Reduce the number of models.`,
			);
			return;
		}
		const turnConvId = this.#deps.convId();
		this.#deps.setBusy(true);
		this.#deps.setError(null);
		// As in `send`: a stale suspend/offline flag from an earlier turn would make
		// runBranch misclassify a genuine branch failure as "Generating…".
		this.#deps.clearInterruptedFlags();

		// Park the comparison and collect the portraits already drawn here. A
		// refusal (the conversation has continued past the description) lands
		// before anything has been dispatched or shown, so the dialog's caller can
		// surface it and nothing has moved.
		let existingPortraits: ChatMessage[];
		try {
			const res = await fetch(`/api/conversations/${turnConvId}/avatar/prepare`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sourceMessageId: input.sourceMessageId,
				} satisfies PrepareAvatarDrawRequest),
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			existingPortraits = ((await res.json()) as PrepareAvatarDrawResponse).siblings;
		} catch (e) {
			if (this.#deps.convId() === turnConvId) {
				this.#deps.setError(e instanceof Error ? e.message : String(e));
			}
			this.#deps.setBusy(false);
			return;
		}
		if (this.#deps.convId() !== turnConvId) {
			this.#deps.setBusy(false);
			return;
		}

		this.#mode = 'avatar';
		this.#avatarDraw = {
			sourceMessageId: input.sourceMessageId,
			prompt: input.prompt,
			enhance: input.enhance,
		};
		this.userMessageId = input.sourceMessageId;
		this.live = true;

		const seeded = this.#buildRecoveredColumns(existingPortraits, [], 'image');
		// Continue past whatever's already under this anchor rather than restarting
		// at 0. An avatar comparison hangs off a REUSED assistant message, so a
		// second draw round's portraits are siblings of the first round's — numbered
		// from 0 again they'd interleave with them in a recovered grid instead of
		// following them. A turn fan-out has a fresh anchor, so its base is always 0.
		const indexBase = nextDispatchIndex(seeded);
		const fresh: FanoutColumn[] = input.branches.map((b, i) => ({
			branchId: `${input.sourceMessageId}:avatar:${i}`,
			dispatchIndex: indexBase + i,
			modelId: b.modelId,
			modelKind: b.modelKind,
			label: b.displayName,
			segments: [],
			status: 'queued' as const,
			queuedAhead: 0,
			progress: null,
			statusLabel: null,
			startedAt: null,
			inputMediaId: null,
			persisted: null,
			error: null,
			errorMessageId: null,
		}));
		this.columns = [...seeded, ...fresh];
		await tick();
		this.#deps.scrollToBottom();
		// The grid keeps the composer parked until the user resolves it; the
		// per-turn `busy` flag can release. (No title spinner: an avatar draw never
		// names the conversation — the route passes suppressTitleTask.)
		this.#deps.setBusy(false);

		// Dispatch only the new branches — `seeded` are already-persisted results.
		//
		// Drive the PROXIED elements, not the `fresh` objects they were built from.
		// Assigning the array into `$state` is what makes its elements reactive, and
		// a branch drives its column by mutating it (status, segments, persisted).
		// Handed the raw objects, every one of those writes lands somewhere
		// `this.columns` never sees: the grid stays on "Queued" forever, and the
		// resolution below reads back two branches that produced nothing, wipes the
		// comparison and reports that no model drew anything — for a draw that in
		// fact succeeded twice. `send` avoids this by iterating `this.columns`, and
		// `regenerate` says so at its own insertion point.
		await this.#dispatchColumns(
			turnConvId,
			input.sourceMessageId,
			this.columns.slice(seeded.length),
		);
		if (this.#deps.convId() !== turnConvId) return;
		if (!this.live) return;
		if (this.columns.some((c) => c.status === 'cancelled')) return;
		// Nothing survived — including any portrait we seeded, since a failed draw
		// leaves the grid with only error columns to discard. Drop it and say so;
		// keep-many means we never auto-promote here the way a chat fan-out does.
		if (!this.columns.some((c) => c.persisted)) {
			this.columns = [];
			this.userMessageId = null;
			this.live = false;
			this.#avatarDraw = null;
			this.#deps.setError('No model produced an image. Try again, or pick another model.');
			try {
				await invalidateAll();
			} catch {
				// Best-effort re-sync; the error is already surfaced above.
			}
		}
	}

	/** Drive one fan-out branch into its column's state. Every kind streams over
	 *  SSE — chat tokens, video progress, and (via the image relay) the image
	 *  queue/start/done — so each branch surfaces its queued-vs-generating state
	 *  uniformly (QUEUED badge + live timer). */
	async #runBranch(
		turnConvId: string,
		userMessageId: string,
		col: FanoutColumn,
		opts?: {
			reroll?: boolean;
			onEnqueued?: () => void;
			fanoutSize?: number;
			/** The dispatch loop's snapshot. Absent for `regenerate`, which fires a
			 *  lone branch with no await ahead of it and so wants the live fields. */
			dispatch?: DispatchMode;
		},
	): Promise<ChatMessage | null> {
		const abort = new AbortController();
		this.#aborts.set(col.branchId, abort);
		// Fired once this branch has reached the endpoint gate (its first SSE
		// event), so the caller can dispatch the next branch in order. Idempotent;
		// the finally backstops it so a branch that fails before any event still
		// releases the dispatch sequence instead of stalling it.
		let enqueuedSignaled = false;
		const markEnqueued = () => {
			if (enqueuedSignaled) return;
			enqueuedSignaled = true;
			opts?.onEnqueued?.();
		};
		try {
			// Two endpoints, one streaming contract: an avatar branch anchors on an
			// assistant message, which the messages route refuses as a fan-out
			// parent, so it goes to the avatar route instead. Both speak the same
			// SSE, which is why everything below this line is shared.
			const { mode, avatar } = opts?.dispatch ?? { mode: this.#mode, avatar: this.#avatarDraw };
			const url =
				mode === 'avatar'
					? `/api/conversations/${turnConvId}/avatar/generate`
					: `/api/conversations/${turnConvId}/messages?stream=1`;
			const body = JSON.stringify(
				mode === 'avatar' && avatar
					? buildAvatarBranchBody({
							sourceMessageId: userMessageId,
							modelId: col.modelId,
							prompt: avatar.prompt,
							enhance: avatar.enhance,
							fanoutSize: opts?.fanoutSize,
							branchIndex: col.dispatchIndex,
						})
					: buildFanoutBranchBody({
							parentMessageId: userMessageId,
							modelId: col.modelId,
							modelKind: col.modelKind,
							inputMediaId: col.inputMediaId,
							reroll: opts?.reroll,
							fanoutSize: opts?.fanoutSize,
							branchIndex: col.dispatchIndex,
						}),
			);
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
				body,
				signal: abort.signal,
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			if (!res.body) throw new Error('Server returned no body');
			await consumeChatStream(res.body, {
				shouldContinue: () => this.#deps.convId() === turnConvId,
				onQueued(ahead) {
					// First event from this branch (it queued at the gate) — release
					// the next branch's dispatch. `ahead` then counts down via the
					// gate's re-emitted `queued` events as the line drains.
					markEnqueued();
					col.status = 'queued';
					col.queuedAhead = ahead;
					// Past the (pre-slot) enhancement phase — drop its transient label.
					col.statusLabel = null;
				},
				onStart() {
					// First event when a slot was free immediately — release the next
					// branch's dispatch.
					markEnqueued();
					col.status = 'streaming';
					// Generation began (slot acquired) — start the per-column timer.
					col.startedAt = Date.now();
					// Past the (pre-slot) enhancement phase — drop its transient label.
					col.statusLabel = null;
				},
				// Content implies a slot — see the same `??=` in chat-turn-controller.
				// A real `start` keeps its own timestamp; this only backstops a
				// stream that reaches content without one, which `generatingNow`
				// (and so the sidebar's mark) would otherwise read as still queued.
				onText(chunk) {
					col.status = 'streaming';
					col.startedAt ??= Date.now();
					col.segments = appendText(col.segments, chunk);
				},
				onReasoning(chunk) {
					col.status = 'streaming';
					col.startedAt ??= Date.now();
					col.segments = appendReasoning(col.segments, chunk);
				},
				onProgress(percent, status) {
					// For an enhanced branch the pre-slot "Enhancing prompt…" status is
					// the first sign of life, so release the next branch's dispatch here
					// too (idempotent) — otherwise dispatch would serialize behind each
					// branch's enhancement. Carries video poll progress (0–100) and the
					// transient phase label; onQueued/onStart clear the label at the gate.
					markEnqueued();
					col.status = 'streaming';
					col.progress = percent;
					col.statusLabel = status;
				},
				onDone({ assistantMessage }) {
					col.persisted = assistantMessage;
					col.progress = null;
					col.startedAt = null;
					col.status = 'done';
				},
				onError(message, persistedMessageId) {
					col.error = message;
					col.status = 'error';
					// The media relay persists a durable error sibling before emitting
					// this frame and hands back its id — keep it so discarding the column
					// deletes the row instead of just hiding it from this session's grid.
					col.errorMessageId = persistedMessageId ?? null;
				},
			});
			// consumeChatStream can resolve on a clean body EOF WITHOUT a terminal
			// done/error event (a proxy idle-timeout or an upstream truncation that
			// still closes gracefully) — the callbacks above never fire, so the
			// column is stuck non-terminal. Left as-is it wedges the grid: the
			// `streaming` derived stays true (composer disabled) and no column ever
			// settles, so the Done/Dismiss control never renders and a media
			// keep-many grid (no pick-to-resolve) has no in-grid escape. Settle it,
			// mirroring the single-send path's finally.
			if (!col.persisted && (col.status === 'streaming' || col.status === 'queued')) {
				if (this.#deps.interrupted()) {
					// Hidden/offline mid-stream — reconcile via server truth rather than
					// flag a false error, matching the catch's interrupted handling.
					if (this.live) {
						this.handoffToRecovery();
						void invalidateAll();
					} else {
						this.columns = this.columns.filter((c) => c.branchId !== col.branchId);
					}
				} else {
					col.error ??= 'Stream ended unexpectedly';
					col.status = 'error';
					col.progress = null;
					col.startedAt = null;
				}
			}
			return col.persisted;
		} catch (e) {
			if (isAbortError(e)) col.status = 'cancelled';
			else if (this.#deps.interrupted()) {
				// This branch's stream died to a suspension / connectivity drop (the
				// page was hidden/offline during the fetch) — not a real failure; the
				// server keeps generating. How we reconcile depends on whether this
				// client still drives the fan-out (the visibility handler deliberately
				// doesn't hand off eagerly, to keep a healthy desktop tab-switch from
				// dropping a live grid).
				if (this.live) {
					// Whole-tab suspend killed the sibling streams too, so park this one
					// at 'streaming' and hand the live fan-out off to server-truth
					// recovery to reconcile it.
					col.status = 'streaming';
					this.handoffToRecovery();
					void invalidateAll();
				} else {
					// A re-roll on an ALREADY-parked grid: this client isn't driving
					// recovery, so a 'streaming' column would dangle with no terminal
					// state (every in-grid control needs a settled column, and neither
					// recovery poll watches a `reroll:` branchId) until the page's
					// return-transition invalidate rebuilds from server truth. Drop it
					// for an immediate in-grid escape; that same server-truth rebuild
					// re-adds the re-roll as a sibling once it lands. The source column
					// remains, so the grid never empties here.
					this.columns = this.columns.filter((c) => c.branchId !== col.branchId);
				}
			} else {
				col.error = e instanceof Error ? e.message : String(e);
				col.status = 'error';
			}
			return null;
		} finally {
			// Backstop: a branch that errored before any SSE event (non-ok
			// response, immediate abort) still unblocks the dispatch sequence.
			markEnqueued();
			this.#aborts.delete(col.branchId);
		}
	}

	/**
	 * Promote a column to the active thread: select its branch, drop the compare
	 * view, and continue the conversation with that model.
	 *
	 * In avatar mode it also makes that portrait the conversation's face, and
	 * doesn't touch the picker — the image model drew a portrait, it didn't become
	 * the model this chat talks to. Both halves go through one endpoint so a
	 * half-landed pick can't leave the header wearing a face from a branch the
	 * thread isn't on.
	 */
	async pick(col: FanoutColumn): Promise<void> {
		if (!col.persisted || this.picking) return;
		this.picking = true;
		const convId = this.#deps.convId();
		const targetId = col.persisted.id;
		const avatarMode = this.#mode === 'avatar';
		// Clear optimistically (avoids a flash of columns + linear bubble during
		// the invalidate), but keep a copy to restore if the select or refetch
		// fails — otherwise a network error would wipe the compare view with no
		// way back short of a full reload.
		const savedColumns = this.columns;
		this.columns = [];
		try {
			const res = avatarMode
				? await fetch(`/api/conversations/${convId}/avatar/pick`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ messageId: targetId }),
					})
				: await fetch(`/api/conversations/${convId}/messages/${targetId}/select`, {
						method: 'POST',
					});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			this.#deps.setStreamedMessageId(targetId);
			await invalidateAll();
			if (!avatarMode) {
				// Continue with the chosen model — the picker reflects it now and the
				// next send persists it. tick() lets the data-sync effect (which resets
				// modelId from the unchanged conversation row) flush first so this wins.
				await tick();
				this.#deps.setActiveModel(col.modelId, col.modelKind);
			}
			this.userMessageId = null;
			this.live = false;
			this.#avatarDraw = null;
		} catch (e) {
			this.columns = savedColumns;
			this.#deps.setError(e instanceof Error ? e.message : String(e));
		} finally {
			this.picking = false;
		}
	}

	/** Finish a comparison without an explicit per-column pick: make the first
	 *  generated branch active (so the thread focuses a real response — the "Done"
	 *  action for media keep-many, where every kept image/video stays a sibling
	 *  reachable via ‹N/M›), then re-sync. */
	async dismiss(): Promise<void> {
		if (this.picking) return;
		this.picking = true;
		const convId = this.#deps.convId();
		// Promote the first real result — never an error column (it has a persisted
		// row, but selecting it would make a failure the active thread).
		//
		// Tested on `!== 'error'` rather than `=== 'done'` because of the branch
		// that lands `persisted` and THEN gets marked 'cancelled': a Stop arriving
		// between the `done` event and the stream close. That column holds a real
		// portrait, and while it was merely unpromotable this only cost a no-op
		// Done — but now that the else-branch clears the marker, treating it as
		// nothing would take the anchor's children off the active branch for good.
		const firstPersisted = this.columns.find((c) => c.persisted && c.status !== 'error');
		// Clear optimistically but restore on failure (see pick).
		const savedColumns = this.columns;
		this.columns = [];
		try {
			if (firstPersisted?.persisted) {
				await fetch(`/api/conversations/${convId}/messages/${firstPersisted.persisted.id}/select`, {
					method: 'POST',
				});
			} else {
				// Nothing to promote — every branch failed. Selecting anything here
				// would be wrong (the only rows under the anchor are error siblings,
				// and `selectBranch` walks to the newest of them), but doing nothing
				// was worse: the marker stayed parked, so `invalidateAll` below rebuilt
				// the very grid this is meant to take down, and Done was a no-op the
				// user could press forever. Clear the marker instead and leave the
				// thread where it is.
				await fetch(`/api/conversations/${convId}/fanout`, { method: 'DELETE' });
			}
			await invalidateAll();
			this.userMessageId = null;
			this.live = false;
			this.#avatarDraw = null;
		} catch (e) {
			this.columns = savedColumns;
			this.#deps.setError(e instanceof Error ? e.message : String(e));
		} finally {
			this.picking = false;
		}
	}

	/** Discard (delete) one media variation — prune a dud. Removes the column and
	 *  deletes its branch server-side; the leaf stays parked at the shared user
	 *  message, so the grid keeps showing the survivors. */
	async discard(col: FanoutColumn): Promise<void> {
		if (this.picking) return;
		this.picking = true;
		const convId = this.#deps.convId();
		// A FAILED column is a persisted row too (`errorMessageId`), not just a
		// client-side scrap of red text — deleting only the local column would let
		// every discarded failure come back on the next rebuild from server truth.
		const branchId = col.persisted?.id ?? col.errorMessageId;
		try {
			if (branchId) {
				const res = await fetch(`/api/conversations/${convId}/messages/${branchId}/branch`, {
					method: 'DELETE',
				});
				if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			}
			this.columns = this.columns.filter((c) => c.branchId !== col.branchId);
			// Defensive: if the grid emptied, drop the parked anchor handle.
			if (this.columns.length === 0) {
				this.userMessageId = null;
				this.live = false;
			}
		} catch (e) {
			this.#deps.setError(e instanceof Error ? e.message : String(e));
		} finally {
			this.picking = false;
		}
	}

	/** Re-roll a media variation: spawn a FRESH sibling with the same model /
	 *  prompt / input image as `col`, added to the grid right after it. Additive
	 *  and non-destructive — the original stays put, so the user can compare the
	 *  re-roll against it and keep whichever they prefer (trashing the other with
	 *  the discard button). */
	async regenerate(col: FanoutColumn): Promise<void> {
		// Per-column + additive, so — like discard — this never takes the grid-wide
		// `picking` lock: the generation runs for many seconds and that lock would
		// freeze every other column's controls for its whole duration. Concurrent
		// re-rolls are safe (each new column owns its own state + branch fetch, and
		// the in-flight fetch keeps an `#aborts` entry that gates the recovery
		// rehydration). Bail only if there's no parked user message to reparent
		// under, or a grid-restructuring op (pick/dismiss/discard) is mid-flight.
		// The branch ceiling is enforced per-render in the grid (Regenerate
		// disables at the active-branch cap) + server-side (429); a click slipping
		// past is a harmless no-op rather than something to error on here.
		if (!this.userMessageId || this.picking) return;
		// An avatar grid recovered from server truth has no prompt to re-roll with;
		// the grid hides the control, and this is the backstop behind it.
		if (!this.canRegenerate) return;
		const convId = this.#deps.convId();
		const newColumn: FanoutColumn = {
			branchId: `reroll:${this.userMessageId}:${this.#nextRerollSeq++}`,
			// Its SOURCE's position, not a fresh one — that's what makes the server
			// sort the re-roll directly after the variation it re-rolled, matching
			// where the live grid inserts it below.
			dispatchIndex: col.dispatchIndex,
			modelId: col.modelId,
			modelKind: col.modelKind,
			label: col.label,
			segments: [],
			status: 'queued',
			queuedAhead: 0,
			progress: null,
			statusLabel: null,
			startedAt: null,
			inputMediaId: col.inputMediaId,
			persisted: null,
			error: null,
			errorMessageId: null,
		};
		// Insert after its source (and after any re-rolls that source already has)
		// so the original and its variations read as one run rather than scattering
		// the re-roll to the end of a growing grid. `rerollInsertIndex` is the live
		// mirror of how a recovered grid sorts the same run — see its docblock.
		const insertAt = rerollInsertIndex(this.columns, col);
		this.columns = [...this.columns.slice(0, insertAt), newColumn, ...this.columns.slice(insertAt)];
		// Drive the proxied element (not the raw `newColumn`) so the column's live
		// state updates stay reactive. `reroll: true` marks this branch a re-roll on
		// the wire; like any fan-out branch it defers to the single aggregate
		// "N ready" notify, which now waits for a mid-flight re-roll instead of
		// firing when the original batch drains. A failed re-roll lands in 'error' (a
		// discardable column) — nothing to restore, the original was never touched.
		await this.#runBranch(convId, this.userMessageId, this.columns[insertAt], { reroll: true });
	}

	/** Stop a streaming fan-out: cancel every branch server-side + locally. */
	async stop(): Promise<void> {
		try {
			await fetch(`/api/conversations/${this.#deps.convId()}/cancel`, { method: 'POST' });
		} catch {
			// Best-effort — aborting locally still gives the "stopped" UX.
		}
		for (const a of this.#aborts.values()) a.abort();
	}

	/** A suspend/disconnect interrupted a live fan-out: its branch fetches are
	 *  dead, but the server kept generating + persisting. Drop the client's hold
	 *  so the server-truth rehydration (+ recovery poll) rebuilds the grid.
	 *  Aborting the dead fetches just clears their slots locally. */
	handoffToRecovery(): void {
		if (!this.live) return;
		for (const a of this.#aborts.values()) a.abort();
		this.#aborts.clear();
		this.live = false;
		// The flags have served their purpose for this turn (the poll drives
		// recovery now). Clear them so a later regenerate on the recovered grid
		// starts clean and can't misread a genuine failure as "Generating…".
		this.#deps.clearInterruptedFlags();
	}

	/** Tear down on conversation switch — abort in-flight branches + drop state.
	 *  The new conversation's columns (if any) re-hydrate from its load data. */
	teardown(): void {
		for (const a of this.#aborts.values()) a.abort();
		this.#aborts.clear();
		this.columns = [];
		this.userMessageId = null;
		this.live = false;
		// The comparison we're leaving belongs to a conversation we're no longer
		// on. `#mode` would be re-established by the next rebuild anyway; the
		// reviewed prompt would not, and it must not follow us. Defence in depth —
		// `#rebuildFrom`'s anchor test is what actually closes this — but cheap, and
		// it stops the stale draw sitting around at all rather than only being
		// disarmed at the moment it would have been used.
		this.#mode = 'turn';
		this.#avatarDraw = null;
	}

	/** Rebuild the compare grid from server-truth recovery state on a reload /
	 *  conversation-switch into a parked fan-out. Skipped while THIS client drives
	 *  the fan-out (live) or has a branch fetch in flight (a live regenerate), so
	 *  it never clobbers the in-session grid. */
	/** Safe to clobber the grid from server truth only when nothing client-driven
	 *  owns it: not live-streaming, no in-flight aborts, not mid-pick, page idle.
	 *  The single predicate, shared by syncFromServer + the recovery poll. */
	#canRebuildFromServer(): boolean {
		return !this.live && this.#aborts.size === 0 && !this.picking && !this.#deps.busy();
	}

	/** Replace the grid with the recovered columns for a parked fan-out. */
	#rebuildFrom(f: FanoutRecoveryState): void {
		this.userMessageId = f.parentMessageId;
		// The mode comes off the wire, not off the columns: a recovered avatar grid
		// is indistinguishable from an image fan-out by its contents, and getting
		// this wrong would make "use this face" continue the chat with SDXL.
		this.#mode = f.avatar ? 'avatar' : 'turn';
		// The reviewed prompt is never RESTORED here — it lives only in the page
		// that dispatched the draw, so a grid rebuilt on a fresh page has none and
		// Regenerate stays off. But one already in hand is KEPT, and only for its
		// own anchor: that's the handoff-to-recovery case, where this page did see
		// the prompt and a re-roll is legitimate.
		//
		// Any other anchor is a different grid — another conversation's parked
		// comparison, or one parked from another tab — and keeping the prompt there
		// is not merely stale, it draws THIS prompt under THAT description. Note
		// that clearing it in `teardown()` alone would not cover the same-anchor-
		// changed case, since a handoff never tears down.
		if (this.#avatarDraw && this.#avatarDraw.sourceMessageId !== f.parentMessageId) {
			this.#avatarDraw = null;
		}
		this.columns = this.#buildRecoveredColumns(f.siblings, pendingBranches(f), f.kind);
	}

	syncFromServer(fanout: FanoutRecoveryState | null | undefined): void {
		if (!this.#canRebuildFromServer()) return;
		if (!fanout?.parentMessageId || (fanout.siblings.length === 0 && fanout.pending === 0)) {
			// No parked fan-out on the server — drop any recovered grid.
			if (this.columns.length > 0) {
				this.columns = [];
				this.userMessageId = null;
				this.#mode = 'turn';
				this.#avatarDraw = null;
			}
			return;
		}
		this.#rebuildFrom(fanout);
	}

	/** True when the grid has server-driven "Generating…" placeholders the client
	 *  isn't streaming — the gate for the recovery poll. */
	get hasRecoveredPending(): boolean {
		return !this.live && this.columns.some((c) => c.branchId.startsWith(RECOVERED_PENDING_PREFIX));
	}

	/** Poll the lightweight GET for fresh recovery state and rebuild the grid as
	 *  branches land, stopping once none are pending. Returns a cleanup fn for the
	 *  caller's $effect. */
	startRecoveryPoll(): () => void {
		const id = this.#deps.convId();
		let stopped = false;
		const interval = setInterval(async () => {
			try {
				// `?fanout=1` skips the conversation's message walk this poll has no
				// use for. It carries a few small fields for its several callers
				// (`fanout`, `inFlightSince`, `avatarDrawSince`); only `fanout` is
				// read here.
				const res = await fetch(`/api/conversations/${id}?fanout=1`);
				if (stopped || !res.ok || this.#deps.convId() !== id) return;
				const body = (await res.json()) as { fanout?: FanoutRecoveryState };
				const f = body.fanout;
				if (!f?.parentMessageId) {
					// Resolved/gone server-side — one full reload to reconcile.
					stopped = true;
					clearInterval(interval);
					await invalidateAll();
					return;
				}
				// Rebuild from fresh server truth (more done, fewer pending) — unless
				// a live interaction (regenerate) has since taken over.
				if (this.#canRebuildFromServer()) this.#rebuildFrom(f);
				if (f.pending === 0) {
					stopped = true;
					clearInterval(interval);
				}
			} catch {
				// Transient — the next tick retries.
			}
		}, 4000);
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	}
}
