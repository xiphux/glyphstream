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
import { buildFanoutBranchBody } from './chat-send-body';
import { consumeChatStream } from './consume-chat-stream';
import { allColumnsSettled, type FanoutBranchSpec, type FanoutColumn } from './fanout';
import { errorMessageFromResponse } from './fetch-error';
import { clearTitlePending, markTitlePending } from './title-pending.svelte';
import type {
	ChatMessage,
	ModelEntry,
	ModelKind,
	PrepareFanoutRequest,
	PrepareFanoutResponse,
} from './types/api';

/** Server-truth recovery state for a parked fan-out (mirrors the server's
 *  getFanoutRecoveryState payload, surfaced by the page load + GET poll). */
export interface FanoutServerState {
	parentMessageId: string | null;
	kind: ModelKind | null;
	siblings: ChatMessage[];
	pending: number;
	/** Model id per still-generating branch (aligned with `pending`), so the
	 *  recovered grid labels each placeholder by model. Optional for back-compat
	 *  with any caller that doesn't supply it. */
	pendingModelIds?: string[];
	/** When each pending branch began generating (aligned with `pendingModelIds`),
	 *  or null while still QUEUED — drives the recovered grid's QUEUED badge vs.
	 *  elapsed timer. */
	pendingStartedAt?: (number | null)[];
}

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
}

/** Per-pending-branch descriptors, normalized to the `pending` count. When the
 *  server reports per-branch start times, each branch is QUEUED (no start yet)
 *  or generating-with-a-timer. An older payload without that info falls back to
 *  plain "Generating…" placeholders (status 'streaming', no timer). */
function pendingBranches(f: FanoutServerState): PendingBranch[] {
	const ids = f.pendingModelIds ?? Array.from({ length: f.pending }, () => '');
	const starts = f.pendingStartedAt;
	return ids.map((modelId, i) => {
		if (!starts) return { modelId, status: 'streaming', startedAt: null };
		const startedAt = starts[i] ?? null;
		return { modelId, status: startedAt !== null ? 'streaming' : 'queued', startedAt };
	});
}

export class FanoutController {
	#deps: FanoutDeps;

	/** Live + settled comparison columns. Non-empty == the compare view is up. */
	columns = $state<FanoutColumn[]>([]);
	/** A pick/dismiss/discard/regenerate request is in flight. */
	picking = $state(false);
	/** The shared user message of the live/parked fan-out — discard/regenerate
	 *  reparent new branches to it. Null when no comparison is active. */
	userMessageId = $state<string | null>(null);
	/** True while THIS client is driving the fan-out (owns the branch fetches).
	 *  False once recovered from server truth after a reload / disconnect, so the
	 *  rehydration may rebuild the grid. */
	live = $state(false);
	/** Per-branch abort controllers, keyed by column branchId, for Stop. */
	#aborts = new Map<string, AbortController>();

	comparing = $derived(this.columns.length > 0);
	streaming = $derived(this.columns.some((c) => c.status === 'queued' || c.status === 'streaming'));
	columnsSettled = $derived(this.columns.length > 0 && allColumnsSettled(this.columns));
	/** Image/video fan-out is keep-many (prune + regenerate); chat is pick-one. */
	isMedia = $derived(this.columns.some((c) => c.modelKind === 'image' || c.modelKind === 'video'));

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
		// Prefer the kind reported by the in-flight branches (so an all-pending
		// media recovery — long for video — renders the media grid immediately,
		// not a brief chat strip); fall back to a persisted sibling's kind.
		const fallbackKind =
			kind ?? (siblings.length > 0 ? (kindById(siblings[0].modelUsed) ?? 'chat') : 'chat');
		const done: FanoutColumn[] = siblings.map((m) => ({
			branchId: m.id,
			modelId: m.modelUsed ?? '',
			modelKind: kindById(m.modelUsed) ?? 'chat',
			label: this.#modelDisplayName(m.modelUsed),
			segments: [],
			status: 'done',
			queuedAhead: 0,
			progress: null,
			startedAt: null,
			inputMediaId: m.sourceMediaId ?? null,
			persisted: m,
			error: null,
		}));
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
			startedAt: pb.startedAt,
			inputMediaId: null,
			persisted: null,
			error: null,
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
	 */
	async send(
		text: string,
		attachedMediaIds: string[],
		branches: FanoutBranchSpec[],
	): Promise<void> {
		const turnConvId = this.#deps.convId();
		const isFirstExchange = this.#deps.messageCount() === 0;
		this.#deps.setBusy(true);
		this.#deps.setError(null);
		// Clear the suspend/offline flags for this turn (mirrors sendStreaming).
		// Without this a stale flag from a prior backgrounded turn would make
		// runBranch misclassify a genuine branch failure as "Generating…".
		this.#deps.clearInterruptedFlags();

		// 1. Create the shared user message (no dispatch).
		let userMessage: ChatMessage;
		try {
			const res = await fetch(`/api/conversations/${turnConvId}/messages/prepare`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text, attachedMediaIds } satisfies PrepareFanoutRequest),
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
			modelId: b.modelId,
			modelKind: b.modelKind,
			label: b.displayName,
			segments: [],
			status: 'queued' as const,
			queuedAhead: 0,
			progress: null,
			startedAt: null,
			inputMediaId: b.inputMediaId,
			persisted: null,
			error: null,
		}));
		await tick();
		this.#deps.scrollToBottom();
		// The compare view keeps the composer disabled until the user picks; the
		// per-turn `busy` flag can release.
		this.#deps.setBusy(false);

		// 3. Stream every branch concurrently.
		try {
			await Promise.all(
				this.columns.map((col) => this.#runBranch(turnConvId, userMessage.id, col)),
			);
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

	/** Drive one fan-out branch into its column's state. Every kind streams over
	 *  SSE — chat tokens, video progress, and (via the image relay) the image
	 *  queue/start/done — so each branch surfaces its queued-vs-generating state
	 *  uniformly (QUEUED badge + live timer). */
	async #runBranch(
		turnConvId: string,
		userMessageId: string,
		col: FanoutColumn,
	): Promise<ChatMessage | null> {
		const abort = new AbortController();
		this.#aborts.set(col.branchId, abort);
		try {
			const body = JSON.stringify(
				buildFanoutBranchBody({
					parentMessageId: userMessageId,
					modelId: col.modelId,
					modelKind: col.modelKind,
					inputMediaId: col.inputMediaId,
				}),
			);
			const res = await fetch(`/api/conversations/${turnConvId}/messages?stream=1`, {
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
					col.status = 'queued';
					col.queuedAhead = ahead;
				},
				onStart() {
					col.status = 'streaming';
					// Generation began (slot acquired) — start the per-column timer.
					col.startedAt = Date.now();
				},
				onText(chunk) {
					col.status = 'streaming';
					col.segments = appendText(col.segments, chunk);
				},
				onReasoning(chunk) {
					col.status = 'streaming';
					col.segments = appendReasoning(col.segments, chunk);
				},
				onProgress(percent) {
					// Video poll-relay progress (0–100), shown in the column header.
					col.status = 'streaming';
					col.progress = percent;
				},
				onDone({ assistantMessage }) {
					col.persisted = assistantMessage;
					col.progress = null;
					col.startedAt = null;
					col.status = 'done';
				},
				onError(message) {
					col.error = message;
					col.status = 'error';
				},
			});
			return col.persisted;
		} catch (e) {
			if (isAbortError(e)) col.status = 'cancelled';
			else if (this.#deps.interrupted()) {
				// This branch's stream died to a suspension / connectivity drop (the
				// page was hidden/offline during the fetch) — not a real failure; the
				// server keeps generating. On a whole-tab suspend the sibling streams
				// died too, so hand the fan-out off to server-truth recovery (which
				// the visibility handler deliberately no longer does eagerly, to keep
				// a healthy desktop tab-switch from dropping the live grid). Idempotent
				// + leaves a non-live grid untouched.
				col.status = 'streaming';
				if (this.live) {
					this.handoffToRecovery();
					void invalidateAll();
				}
			} else {
				col.error = e instanceof Error ? e.message : String(e);
				col.status = 'error';
			}
			return null;
		} finally {
			this.#aborts.delete(col.branchId);
		}
	}

	/** Promote a column to the active thread: select its branch, drop the compare
	 *  view, and continue the conversation with that model. */
	async pick(col: FanoutColumn): Promise<void> {
		if (!col.persisted || this.picking) return;
		this.picking = true;
		const convId = this.#deps.convId();
		const targetId = col.persisted.id;
		// Clear optimistically (avoids a flash of columns + linear bubble during
		// the invalidate), but keep a copy to restore if the select or refetch
		// fails — otherwise a network error would wipe the compare view with no
		// way back short of a full reload.
		const savedColumns = this.columns;
		this.columns = [];
		try {
			const res = await fetch(`/api/conversations/${convId}/messages/${targetId}/select`, {
				method: 'POST',
			});
			if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			this.#deps.setStreamedMessageId(targetId);
			await invalidateAll();
			// Continue with the chosen model — the picker reflects it now and the
			// next send persists it. tick() lets the data-sync effect (which resets
			// modelId from the unchanged conversation row) flush first so this wins.
			await tick();
			this.#deps.setActiveModel(col.modelId, col.modelKind);
			this.userMessageId = null;
			this.live = false;
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
		const firstPersisted = this.columns.find((c) => c.persisted);
		// Clear optimistically but restore on failure (see pick).
		const savedColumns = this.columns;
		this.columns = [];
		try {
			if (firstPersisted?.persisted) {
				await fetch(`/api/conversations/${convId}/messages/${firstPersisted.persisted.id}/select`, {
					method: 'POST',
				});
			}
			await invalidateAll();
			this.userMessageId = null;
			this.live = false;
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
		try {
			if (col.persisted) {
				const res = await fetch(
					`/api/conversations/${convId}/messages/${col.persisted.id}/branch`,
					{
						method: 'DELETE',
					},
				);
				if (!res.ok) throw new Error(await errorMessageFromResponse(res));
			}
			this.columns = this.columns.filter((c) => c.branchId !== col.branchId);
			// Defensive: if the grid emptied, drop the parked user-message handle.
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

	/** Re-roll one media variation in place: generate a fresh sibling with the
	 *  same model/prompt, then delete the old one once the new one lands. */
	async regenerate(col: FanoutColumn): Promise<void> {
		// Serialize against the other grid mutations (pick/dismiss/discard) — an
		// overlapping discard during an in-flight re-roll could otherwise drop the
		// last kept variation past the "keep at least one" guard.
		if (!this.userMessageId || this.picking) return;
		this.picking = true;
		const convId = this.#deps.convId();
		const oldId = col.persisted?.id ?? null;
		// Snapshot so a failed re-roll restores the original (mirrors pick/dismiss)
		// instead of leaving the column stuck on "Failed".
		const snapshot = {
			persisted: col.persisted,
			status: col.status,
			segments: col.segments,
			error: col.error,
			progress: col.progress,
			startedAt: col.startedAt,
		};
		col.persisted = null;
		col.error = null;
		col.segments = [];
		col.progress = null;
		col.startedAt = null;
		col.status = 'streaming';
		try {
			const fresh = await this.#runBranch(convId, this.userMessageId, col);
			if (!fresh) {
				// Re-roll failed / was cancelled — restore the original.
				col.persisted = snapshot.persisted;
				col.status = snapshot.status;
				col.segments = snapshot.segments;
				col.error = snapshot.error;
				col.progress = snapshot.progress;
				col.startedAt = snapshot.startedAt;
				return;
			}
			// Replace: now that a new sibling exists, drop the old one. Best-effort
			// — a leftover old variation is harmless (extra sibling).
			if (oldId && fresh.id !== oldId) {
				try {
					await fetch(`/api/conversations/${convId}/messages/${oldId}/branch`, {
						method: 'DELETE',
					});
				} catch {
					// The new media is already in the column; ignore a failed cleanup.
				}
			}
		} finally {
			this.picking = false;
		}
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
	}

	/** Rebuild the compare grid from server-truth recovery state on a reload /
	 *  conversation-switch into a parked fan-out. Skipped while THIS client drives
	 *  the fan-out (live) or has a branch fetch in flight (a live regenerate), so
	 *  it never clobbers the in-session grid. */
	syncFromServer(fanout: FanoutServerState | null | undefined): void {
		if (this.live || this.#aborts.size > 0 || this.#deps.busy() || this.picking) return;
		if (!fanout?.parentMessageId || (fanout.siblings.length === 0 && fanout.pending === 0)) {
			// No parked fan-out on the server — drop any recovered grid.
			if (this.columns.length > 0) {
				this.columns = [];
				this.userMessageId = null;
			}
			return;
		}
		this.userMessageId = fanout.parentMessageId;
		this.columns = this.#buildRecoveredColumns(
			fanout.siblings,
			pendingBranches(fanout),
			fanout.kind,
		);
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
				const res = await fetch(`/api/conversations/${id}`);
				if (stopped || !res.ok || this.#deps.convId() !== id) return;
				const body = (await res.json()) as { fanout?: FanoutServerState };
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
				if (!this.live && this.#aborts.size === 0 && !this.picking && !this.#deps.busy()) {
					this.userMessageId = f.parentMessageId;
					this.columns = this.#buildRecoveredColumns(f.siblings, pendingBranches(f), f.kind);
				}
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
