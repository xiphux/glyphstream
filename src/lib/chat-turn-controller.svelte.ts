/**
 * Single-turn chat orchestration — the client-side state machine for the
 * ordinary (non-fan-out) turn lifecycle: send / edit / retry streaming, the
 * untrusted-tool approval-resume, and server-truth recovery of a generation
 * whose local fetch died (iOS suspend / network drop). Extracted from the chat
 * page so the four flows that used to mutate the same shared render state
 * inline — coordinated by ad-hoc `convId === turnConvId` / `activeAbort ===
 * abort` conventions — live behind one object with injected deps, unit-testable
 * in isolation. Mirrors fanout-controller.svelte.ts (a `$state` class the page
 * hosts); the two share the interruption flags (this controller owns them, the
 * fan-out reads them through `interrupted`).
 *
 * Owns: the in-flight bubble state (segments + open/progress/status/queued/
 * mcp-unavailable), the per-turn `busy`/`activeAbort`, the just-streamed message
 * id, the approval-resume latch, and the suspend/offline flags. Reaches shared
 * page state (the message list, the per-turn model, the title, the canvas pane,
 * the scroll bindings, the server in-flight marker, the fan-out's comparing
 * state) through the injected `ChatTurnDeps` rather than importing the page.
 * `#runChatStream` is the private SSE binding both the send and the resume path
 * drive.
 */

import { tick } from 'svelte';
import { invalidateAll } from '$app/navigation';
import { isAbortError } from './abort';
import type { ApprovalDecision } from './approval-workflow';
import { runApprovalResume } from './approval-workflow';
import {
	appendReasoning,
	appendText,
	inFlightToBlocks,
	markToolCallPendingApproval,
	pushToolCall,
	updateToolCallArgs,
	updateToolCallResult,
	type InFlightSegment,
} from './chat-render';
import { buildSendRequestBody, type SendOptions } from './chat-send-body';
import { consumeChatStream } from './consume-chat-stream';
import { errorMessageFromResponse } from './fetch-error';
import { clearTitlePending, markTitlePending } from './title-pending.svelte';
import type {
	CanvasVersion,
	ChatMessage,
	McpUnavailableServer,
	MessagePart,
	ModelKind,
} from './types/api';

/** Everything the controller needs from the host page. Getters for reactive
 *  reads; setters/callbacks for the shared state it must mutate. */
export interface ChatTurnDeps {
	/** Current conversation id — snapshotted per turn for the abandon-on-switch
	 *  guards and read fresh for fetch URLs. */
	convId(): string;
	/** The rendered message list (read to trim/append optimistically). */
	getMessages(): ChatMessage[];
	/** Replace the rendered message list. */
	setMessages(next: ChatMessage[]): void;
	/** The per-turn model + kind, for the wire body + the optimistic bubble. */
	modelId(): string;
	modelKind(): ModelKind | null;
	/** The composer's error banner. */
	setError(message: string | null): void;
	/** The approval-prompt's inline error (distinct from the composer banner). */
	setApprovalError(message: string | null): void;
	/** Drop the user's per-tool approval selections after a resume commits. */
	clearApprovalDecisions(): void;
	/** Task-model auto-title arrived ahead of `done` — update the header now. */
	setTitle(title: string): void;
	/** A create_canvas / update_canvas edit landed mid-stream. */
	applyCanvas(canvas: CanvasVersion): void;
	/** Whether the viewport is near the bottom (gates streaming auto-scroll). */
	isNearBottom(): boolean;
	scrollToBottom(): void;
	/** Server's in-flight registry start time for this conversation (unix ms),
	 *  or null — mirrored from the load function, drives `recoveredInFlight`. */
	serverInFlightSince(): number | null;
	/** True while a fan-out comparison owns the in-flight display (its columns),
	 *  so the single recovered bubble stays suppressed. */
	fanoutComparing(): boolean;
}

export class ChatTurnController {
	#deps: ChatTurnDeps;

	/** In-flight assistant render state. While streaming we show a transient
	 *  "assistant" bubble that isn't yet a row in the messages array; on `done`
	 *  we splice the canonical persisted ChatMessage into messages. Content is a
	 *  single ordered list of segments — reasoning, text, and tool_call
	 *  interleaved in arrival order. */
	inFlightSegments = $state<InFlightSegment[]>([]);
	inFlightOpen = $state(false);
	inFlightProgress = $state<number | null>(null);
	inFlightStatus = $state<string | null>(null);
	/** Set when the server emits a `queued` event (the endpoint's max_concurrent
	 *  was full); drives the "Queued…" placeholder in the in-flight bubble. */
	inFlightQueued = $state<{ ahead: number } | null>(null);
	/** Set when the server emits an `mcp_unavailable` event (a conversation-
	 *  enabled per-user MCP server is down and its tools were skipped). */
	inFlightMcpUnavailable = $state<McpUnavailableServer[]>([]);

	/** The per-turn busy flag: a local generation this client is driving. */
	busy = $state(false);
	/** AbortController for the in-flight fetch. Stop / a newer turn / a
	 *  conversation switch call .abort() on it. */
	activeAbort = $state<AbortController | null>(null);
	/** The assistant message id that just finished streaming / generating — its
	 *  content was already on screen as the in-flight bubble, so the persisted
	 *  row suppresses its arrival fade when it mounts. */
	streamedMessageId = $state<string | null>(null);
	/** An approval-resume request is streaming (the composer disables + Send
	 *  flips to Stop while the resumed iteration runs). */
	approvalSubmitting = $state(false);

	/** Monotonic latch owner for `approvalSubmitting`. A resume's `finally`
	 *  clears the flag only if it still owns this token — so a stale resume from
	 *  a conversation we've since left can't clear the flag out from under a NEW
	 *  resume that has since started on the destination thread. Same ownership
	 *  convention as `activeAbort === abort`. */
	#approvalSubmitToken = 0;

	/** Tracks whether the page got backgrounded / went offline while a fetch was
	 *  in flight. iOS suspends PWAs after a few seconds backgrounded, and a
	 *  wifi↔cellular handoff drops in-flight TCP — both kill the request and
	 *  surface as a generic "Load failed" TypeError, indistinguishable from a real
	 *  failure. The page's visibility/online listeners flip these so the catch
	 *  blocks treat the interruption like an abort (silent invalidate, no
	 *  misleading toast). Reset at the top of each send. */
	#wasHiddenDuringFetch = false;
	#wasOfflineDuringFetch = false;

	inFlightBlocks = $derived(inFlightToBlocks(this.inFlightSegments));

	constructor(deps: ChatTurnDeps) {
		this.#deps = deps;
	}

	/** True when either interruption flag is set (a suspend or a connectivity
	 *  drop happened during this turn). Read by the fan-out controller too. */
	get interrupted(): boolean {
		return this.#wasHiddenDuringFetch || this.#wasOfflineDuringFetch;
	}
	/** Read by the page's visibility handler to decide whether to re-sync on
	 *  return to foreground. */
	get wasHiddenDuringFetch(): boolean {
		return this.#wasHiddenDuringFetch;
	}
	/** Read by the page's online handler to decide whether to re-sync. */
	get wasOfflineDuringFetch(): boolean {
		return this.#wasOfflineDuringFetch;
	}
	/** The page went hidden mid-turn (visibilitychange). */
	markHidden(): void {
		this.#wasHiddenDuringFetch = true;
	}
	/** The page went offline mid-turn (the `offline` event). */
	markOffline(): void {
		this.#wasOfflineDuringFetch = true;
	}
	/** Clear both interruption flags (turn start + recovery handoff). */
	clearInterruptedFlags(): void {
		this.#wasHiddenDuringFetch = false;
		this.#wasOfflineDuringFetch = false;
	}

	/**
	 * Server-reported truth: a generation is running for this conversation but
	 * this client isn't driving it — its fetch died (iOS suspended the PWA, the
	 * network dropped). The leaf check matters: the registry entry lingers a
	 * little past the message itself (the SSE stream stays open through the
	 * background title task), so `serverInFlightSince` can still be set for a
	 * generation that already produced its assistant turn. A live/parked fan-out
	 * owns the in-flight display via its columns, so don't also surface the
	 * single recovered bubble while it's comparing.
	 */
	get recoveredInFlight(): boolean {
		const msgs = this.#deps.getMessages();
		return (
			this.#deps.serverInFlightSince() !== null &&
			!this.inFlightOpen &&
			!this.#deps.fanoutComparing() &&
			msgs[msgs.length - 1]?.role !== 'assistant'
		);
	}

	#resetInFlightSegments(): void {
		this.inFlightSegments = [];
		this.inFlightQueued = null;
		this.inFlightMcpUnavailable = [];
	}

	/**
	 * Build a placeholder user message rendered optimistically so the bubble
	 * appears the moment the user hits Send, before the upstream call (seconds
	 * for chat, minutes for image/video) comes back. The canonical persisted
	 * message replaces it on the SSE 'start' event. The temp id is prefixed
	 * `optimistic-` so id-comparing code can recognize it.
	 */
	#buildOptimisticUserMessage(text: string, attachedMediaIds: string[]): ChatMessage {
		const parts: MessagePart[] = [];
		if (text) parts.push({ type: 'text', text });
		for (const mediaId of attachedMediaIds) {
			parts.push({ type: 'image', mediaId });
		}
		return {
			id: `optimistic-${crypto.randomUUID()}`,
			role: 'user',
			parts,
			contentHtml: null,
			reasoningText: null,
			finishReason: null,
			modelUsed: null,
			tokensIn: null,
			tokensOut: null,
			genMs: null,
			createdAt: Date.now(),
		};
	}

	/**
	 * Drive the SSE consumer (extracted to consume-chat-stream so its event-loop
	 * semantics are unit-tested) with the chat-page UI bindings. Used by the send
	 * / edit / retry path (`send`) AND the approval-resume path
	 * (`#runApprovalStream`) — both want identical handling, including
	 * `tool_pending_approval` flipping the in-flight tool segment to render the
	 * inline Allow/Always/Reject buttons live.
	 *
	 * Returns whether the stream included tool calls so the caller can decide
	 * between keeping the in-flight bubble visible until invalidate lands the
	 * canonical intermediate rows, or clearing it immediately.
	 */
	#runChatStream(
		body: ReadableStream<Uint8Array>,
		ctx: {
			turnConvId: string;
			optimisticId: string | null;
			/** Fired when `done` arrives so the caller can flip its busy flag
			 *  mid-stream (background title delivery keeps the SSE open past done). */
			onDone?: () => void;
		},
	): Promise<{ sawToolCalls: boolean }> {
		return consumeChatStream(body, {
			// Abandoned mid-stream by a conversation switch — stop touching shared
			// render state; it belongs to a different conversation now.
			shouldContinue: () => this.#deps.convId() === ctx.turnConvId,
			onQueued: (ahead) => {
				// Waiting on a per-endpoint concurrency slot. Show "Queued…" until
				// the slot is granted and the first real event lands.
				this.inFlightQueued = { ahead };
				// Past the (pre-slot) enhancement phase — drop its transient status.
				this.inFlightStatus = null;
			},
			onMcpUnavailable: (servers) => {
				// A conversation-enabled per-user MCP server is down; its tools were
				// skipped this turn. Surface the inline notice on the bubble.
				this.inFlightMcpUnavailable = servers;
			},
			onStart: async (userMessage) => {
				this.inFlightQueued = null;
				this.inFlightStatus = null;
				// Send / edit: replace the optimistic placeholder with the canonical
				// persisted user message. Retry + resume: no optimistic id (their
				// start event carries the prior user message we already render), so
				// this branch is a no-op.
				if (ctx.optimisticId) {
					const cur = this.#deps.getMessages();
					this.#deps.setMessages(
						cur.some((m) => m.id === ctx.optimisticId)
							? cur.map((m) => (m.id === ctx.optimisticId ? userMessage : m))
							: [...cur, userMessage],
					);
					await tick();
					this.#deps.scrollToBottom();
				}
			},
			onText: (chunk) => {
				this.inFlightQueued = null;
				this.inFlightSegments = appendText(this.inFlightSegments, chunk);
				if (this.#deps.isNearBottom()) this.#deps.scrollToBottom();
			},
			onReasoning: (chunk) => {
				this.inFlightQueued = null;
				this.inFlightSegments = appendReasoning(this.inFlightSegments, chunk);
				if (this.#deps.isNearBottom()) this.#deps.scrollToBottom();
			},
			onToolCallStart: (toolCallId, toolName) => {
				this.inFlightQueued = null;
				this.inFlightSegments = pushToolCall(this.inFlightSegments, toolCallId, toolName);
				if (this.#deps.isNearBottom()) this.#deps.scrollToBottom();
			},
			onToolCallArgsDelta: (toolCallId, argumentsDelta) => {
				this.inFlightSegments = updateToolCallArgs(
					this.inFlightSegments,
					toolCallId,
					argumentsDelta,
				);
			},
			onToolCallResult: (toolCallId, result, isError) => {
				this.inFlightSegments = updateToolCallResult(
					this.inFlightSegments,
					toolCallId,
					result,
					isError,
				);
			},
			onCanvasVersion: (c) => {
				// A create_canvas / update_canvas edit landed — swap the pane to the
				// new server-rendered state and flash the change.
				this.#deps.applyCanvas(c);
			},
			onToolPendingApproval: (toolCallId, toolName, args) => {
				// Untrusted MCP tool — the relay halted before executing. Flip the
				// in-flight segment to pending_approval so the Allow/Always/Reject
				// buttons appear right where the tool call rendered, without waiting
				// for the post-stream invalidate.
				this.inFlightSegments = markToolCallPendingApproval(
					this.inFlightSegments,
					toolCallId,
					toolName,
					args,
				);
				if (this.#deps.isNearBottom()) this.#deps.scrollToBottom();
			},
			onProgress: (percent, status) => {
				this.inFlightQueued = null;
				this.inFlightProgress = percent;
				this.inFlightStatus = status;
			},
			onTitle: (newTitle) => {
				// Task-model auto-title arrived ahead of `done`. Update the chat-page
				// header immediately; the sidebar refreshes via invalidateAll after
				// the stream closes.
				this.#deps.setTitle(newTitle);
			},
			onDone: ({ assistantMessage, sawToolCalls }) => {
				// Single-iteration turn: optimistically append the final assistant
				// message and clear in-flight — snappy because `done`'s message is the
				// only new server-side row.
				//
				// Multi-iteration turn (sawToolCalls): `done` carries only the FINAL
				// iteration's row; the intermediate assistant + role:'tool' rows live
				// in the DB and come back via invalidateAll once the stream closes.
				// Keep the in-flight bubble visible until then so the user doesn't
				// stare at a blank gap.
				this.streamedMessageId = assistantMessage.id;
				if (!sawToolCalls) {
					this.#deps.setMessages([...this.#deps.getMessages(), assistantMessage]);
					this.inFlightOpen = false;
					this.#resetInFlightSegments();
				}
				this.inFlightProgress = null;
				this.inFlightStatus = null;
				ctx.onDone?.();
			},
			onError: (message) => {
				this.#deps.setError(message);
				this.inFlightOpen = false;
				this.inFlightProgress = null;
				this.inFlightStatus = null;
				this.#resetInFlightSegments();
			},
		});
	}

	/**
	 * Shared catch-side reconciliation for the send path.
	 *
	 * AbortError from clicking Stop is expected — don't surface it. The
	 * interruption flags are the "client connection died, server still has the
	 * generation" cases (iOS suspend / network handoff): the fetch error is a
	 * connectivity artifact, not a server failure, so re-sync against the
	 * conversation instead of a misleading toast. All of this is render state for
	 * `turnConvId`'s thread — skip it if the user has since navigated away.
	 */
	#handleSendError(e: unknown, turnConvId: string): void {
		if (this.#deps.convId() !== turnConvId) return;
		if (isAbortError(e) || this.interrupted) {
			void invalidateAll();
		} else {
			this.#deps.setError(e instanceof Error ? e.message : String(e));
		}
		this.inFlightOpen = false;
	}

	/**
	 * Send / edit / retry — stream one assistant turn over SSE (chat tokens,
	 * image/video progress, the per-endpoint queue + start/done). Renders an
	 * optimistic user bubble for send/edit; for retry trims the retried subtree
	 * so the in-flight bubble takes its slot. The higher-level orchestration
	 * (skill stripping, fan-out vs single-send decision, auto-compaction,
	 * composer clearing) stays on the page — this drives the wire + the bubble.
	 */
	async send(
		text: string,
		attachedMediaIds: string[] = [],
		options: SendOptions = {},
	): Promise<void> {
		// The conversation this turn belongs to. The chat-page component is reused
		// across conversation navigations, so by the time an await below resolves
		// the user may be looking at a different conversation — every post-await
		// mutation of shared render state is guarded against `convId` moving on.
		const turnConvId = this.#deps.convId();
		// First exchange ⇒ the server runs the auto-title task once the response
		// lands; drives the sidebar's title spinner.
		const isFirstExchange = this.#deps.getMessages().length === 0;
		this.busy = true;
		this.#deps.setError(null);
		this.clearInterruptedFlags();
		this.#resetInFlightSegments();
		this.inFlightProgress = null;
		this.inFlightStatus = null;

		// For send / edit: render an optimistic user bubble. For retry: the user
		// message already exists, so skip — but DO trim the retry target (and any
		// descendants on the active branch) out of the visible list so the
		// in-flight bubble visually takes the retried message's slot. Otherwise
		// the user briefly sees the old response above the streaming new one until
		// invalidateAll runs after 'done'.
		const isRetry = !!options.retryFromMessageId;
		let optimisticId: string | null = null;
		let sawToolCalls = false;
		if (isRetry) {
			// Trim the retry target AND everything in its multi-iteration tool chain
			// — walk back from the target through preceding assistant/tool rows until
			// the user message that started the turn. Server-side retry re-anchors at
			// that user message (same logic, see the messages +server.ts).
			const msgs = this.#deps.getMessages();
			const retryIdx = msgs.findIndex((m) => m.id === options.retryFromMessageId);
			if (retryIdx >= 0) {
				let cutIdx = retryIdx;
				while (cutIdx > 0 && msgs[cutIdx - 1].role !== 'user') {
					cutIdx--;
				}
				this.#deps.setMessages(msgs.slice(0, cutIdx));
			}
		} else {
			// Edit case: trim everything from the edited message onward so the new
			// optimistic bubble visually replaces it. Without this the old branch's
			// tail would still render above the in-flight bubble, making it look like
			// a new message at the end instead of a sibling replacing the edited one.
			if (options.editedMessageId) {
				const msgs = this.#deps.getMessages();
				const editIdx = msgs.findIndex((m) => m.id === options.editedMessageId);
				if (editIdx >= 0) this.#deps.setMessages(msgs.slice(0, editIdx));
			}
			const opt = this.#buildOptimisticUserMessage(text, attachedMediaIds);
			this.#deps.setMessages([...this.#deps.getMessages(), opt]);
			optimisticId = opt.id;
		}
		// Flip the in-flight bubble on BEFORE the tick+scroll so the
		// "Thinking…/Generating…" row is in the DOM when we measure — otherwise
		// scrollToBottom lands with the optimistic user message at the viewport
		// bottom and the in-flight bubble renders one row below it, off-screen.
		this.inFlightOpen = true;
		if (!isRetry) {
			await tick();
			this.#deps.scrollToBottom();
		}

		// First message of a conversation ⇒ the server auto-titles it once the
		// response lands. Flag the sidebar spinner now, at submit time, so the
		// title slot reads as "a title is coming". `clearTitlePending` in the
		// `finally` removes it once the title task has run.
		if (isFirstExchange) markTitlePending(turnConvId);

		const abort = new AbortController();
		this.activeAbort = abort;
		// Wire body construction lives in `buildSendRequestBody` — see that module
		// for the three modes (retry, edit, plain send).
		const requestBody = buildSendRequestBody({
			text,
			attachedMediaIds,
			modelId: this.#deps.modelId(),
			modelKind: this.#deps.modelKind(),
			options,
		});
		try {
			const res = await fetch(`/api/conversations/${turnConvId}/messages?stream=1`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'text/event-stream',
				},
				body: JSON.stringify(requestBody),
				signal: abort.signal,
			});
			if (!res.ok) {
				throw new Error(await errorMessageFromResponse(res));
			}
			if (!res.body) throw new Error('Server returned no body');

			const consumed = await this.#runChatStream(res.body, {
				turnConvId,
				optimisticId,
				onDone: () => {
					// Release the composer now — `done` means the response is complete.
					// The relay keeps the SSE stream open past this point so the
					// background auto-title task can still deliver a `title` event
					// (first exchange only); the for-await loop keeps reading for it.
					// But the user must not be blocked from sending a follow-up while a
					// cosmetic title generates, so `busy` releases here rather than in
					// `finally` (which only runs once the stream actually closes).
					this.busy = false;
				},
			});
			sawToolCalls = consumed.sawToolCalls;
			if (this.#deps.convId() === turnConvId) {
				// Await the reload so the in-flight bubble (still visible for
				// multi-iteration tool turns — see the `done` handler) only clears
				// once the canonical message rows are in `messages`.
				await invalidateAll();
				if (sawToolCalls) {
					this.inFlightOpen = false;
					this.#resetInFlightSegments();
					this.inFlightProgress = null;
					this.inFlightStatus = null;
				}
			}
		} catch (e) {
			this.#handleSendError(e, turnConvId);
		} finally {
			// The stream has closed — the title task (if any) has delivered or timed
			// out. Drop the sidebar spinner. Gated on isFirstExchange so a fast
			// follow-up turn can't clear a spinner it didn't set.
			if (isFirstExchange) clearTitlePending(turnConvId);
			// Only the turn that still owns the controller clears it — a conversation
			// switch (or a newer turn) may have replaced it. The in-flight transients
			// live here (not in the 'done' / 'error' cases) so a stream that closes
			// without either event — or a success/catch path that early-returned on a
			// convId mismatch — still leaves the bubble closed.
			if (this.activeAbort === abort) {
				this.inFlightOpen = false;
				this.#resetInFlightSegments();
				this.inFlightProgress = null;
				this.inFlightStatus = null;
				this.busy = false;
				this.activeAbort = null;
			}
		}
	}

	/**
	 * Submit the user's per-tool approval decisions to the resume endpoint and
	 * stream the resumed iteration into the in-flight bubble. The page owns the
	 * decision map + the auto-submit effect; this owns the latch + the resume
	 * stream. `decisions` is the snapshot the page built from the merged
	 * live+persisted pending-id set.
	 */
	async submitApproval(decisions: ApprovalDecision[]): Promise<void> {
		if (this.approvalSubmitting) return;
		const token = ++this.#approvalSubmitToken;
		this.approvalSubmitting = true;
		this.#deps.setApprovalError(null);
		try {
			await this.#runApprovalStream(this.#deps.convId(), decisions);
			this.#deps.clearApprovalDecisions();
			await invalidateAll();
		} catch (e) {
			// AbortError from clicking Stop mid-resume is expected and shouldn't
			// surface as a red banner — same convention as the initial-send path.
			// The server-side recorder will have committed whatever partial text it
			// had; invalidateAll on the way out picks that up.
			if (!isAbortError(e)) {
				this.#deps.setApprovalError(e instanceof Error ? e.message : String(e));
			}
			await invalidateAll();
		} finally {
			// Only clear if we still own the latch — a thread switch (teardown) or a
			// newer resume may have taken it while we were parked on invalidateAll().
			if (this.#approvalSubmitToken === token) this.approvalSubmitting = false;
		}
	}

	async #runApprovalStream(convId: string, decisions: ApprovalDecision[]): Promise<void> {
		const turnConvId = convId;
		// Open the in-flight bubble so the user sees text + tool calls streaming in
		// live instead of staring at "Resuming…" for the duration of the response.
		this.#resetInFlightSegments();
		this.inFlightProgress = null;
		this.inFlightStatus = null;
		this.inFlightOpen = true;
		// Reuse the same Stop wiring the send path uses — the in-flight registry on
		// the server keys by conversation id, so stop()'s POST to /cancel reaches
		// the resumed upstream call, and aborting `activeAbort` here tears down our
		// local fetch. Without this the user has no way to halt a runaway resumed
		// generation (small models in a thinking loop, etc.).
		const abort = new AbortController();
		this.activeAbort = abort;
		try {
			const { sawToolCalls } = await runApprovalResume(convId, decisions, abort.signal, (body) =>
				this.#runChatStream(body, {
					turnConvId,
					optimisticId: null,
					// onDone omitted — approvalSubmitting clears in the caller's finally
					// so the inline buttons stay disabled until the invalidate completes
					// and the persisted rows surface.
				}),
			);
			if (this.#deps.convId() === turnConvId) {
				await invalidateAll();
				if (sawToolCalls) {
					this.inFlightOpen = false;
					this.#resetInFlightSegments();
					this.inFlightProgress = null;
					this.inFlightStatus = null;
				}
			}
		} finally {
			if (this.activeAbort === abort) this.activeAbort = null;
		}
	}

	/**
	 * Stop a streaming single-turn / resumed generation: tell the server to tear
	 * down upstream first (so the bridge stops generating instead of running to
	 * completion), then abort the local fetch. A recovered bubble has no local
	 * fetch to abort, but the server generation is still registered — /cancel
	 * reaches it by conversation id all the same, and a re-sync lands the
	 * cancelled state. Fan-out streaming has its own per-branch stop, handled by
	 * the page's dispatcher before it reaches here.
	 */
	async stop(): Promise<void> {
		const abort = this.activeAbort;
		if (!abort && !this.recoveredInFlight) return;
		try {
			await fetch(`/api/conversations/${this.#deps.convId()}/cancel`, { method: 'POST' });
		} catch {
			// Best-effort — even if the cancel POST fails, aborting locally still
			// gives the user the "stopped" UX.
		}
		if (abort) {
			abort.abort();
		} else {
			// Recovered case: nothing local to abort. Re-sync so the cancelled state
			// lands; the recovery poll backstops this if the server hasn't finished
			// tearing down yet.
			void invalidateAll();
		}
	}

	/**
	 * While a generation runs server-side that this client isn't driving (a
	 * recovered bubble — the local fetch died to an iOS suspension or dropped
	 * connection), poll the lightweight conversation endpoint so the
	 * "Generating…" bubble resolves the moment the generation finishes — even if
	 * the user just stays in the app. invalidateAll() is too heavy to poll (it
	 * re-fetches every endpoint's model list); the GET endpoint is DB-only.
	 * Returns a cleanup fn for the caller's $effect.
	 */
	startRecoveryPoll(): () => void {
		const id = this.#deps.convId();
		let stopped = false;
		const interval = setInterval(async () => {
			try {
				const res = await fetch(`/api/conversations/${id}`);
				if (stopped || !res.ok) return;
				const body = (await res.json()) as {
					conversation: { messages: Array<{ role: string }> };
					inFlightSince: number | null;
				};
				// Done when the assistant turn has landed (the timely signal — beats
				// the registry, which lingers through the title task) or the registry
				// cleared with no message (a cancelled generation).
				const msgs = body.conversation.messages;
				const finished = msgs[msgs.length - 1]?.role === 'assistant' || body.inFlightSince === null;
				if (finished && !stopped) {
					stopped = true;
					clearInterval(interval);
					// One full reload to pull in the finished message, the AI title, and
					// the now-cleared in-flight state.
					await invalidateAll();
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

	/**
	 * Abandon the in-flight turn on a conversation switch. The chat-page component
	 * is reused across /chat/[id] → /chat/[id] navigations, so a send fired in
	 * conversation A keeps its fetch + closure alive after the user switches to B.
	 * Without this reset B inherits A's open bubble and A's completion handler
	 * would graft A's messages onto B's list. Aborting the fetch is safe: the
	 * server keeps generating regardless of the client connection and fires its
	 * push notification when done. Also clears the approval-resume latch (a resume
	 * streams under `approvalSubmitting`, not `busy`, and registers its abort in
	 * `activeAbort`).
	 */
	teardown(): void {
		this.activeAbort?.abort();
		this.activeAbort = null;
		this.busy = false;
		this.approvalSubmitting = false;
		this.inFlightOpen = false;
		this.#resetInFlightSegments();
		this.inFlightProgress = null;
		this.inFlightStatus = null;
	}
}
