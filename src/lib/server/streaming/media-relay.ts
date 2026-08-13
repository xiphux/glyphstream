/**
 * Shared scaffold for the one-shot media relays (image + video). Both modalities
 * wrap an identical lifecycle around a small modality-specific core, so that
 * lifecycle lives here once:
 *
 *   per-endpoint slot acquire (+ `queued` emission, + cancel-while-queued)
 *   → onStarted + `start`
 *   → first-exchange title task (suppressed for fan-out — /prepare owns it)
 *   → [modality-specific generate: produce + persist the media bytes]
 *   → append as a sibling (active_leaf pinned for fan-out) + link media
 *   → push notify
 *   → `done` + race the title → `title`
 *   → finally: release the slot + onComplete
 *
 * The ONLY per-modality piece is `generate` (image = one-shot edit/gen; video =
 * create + poll loop). The chat relay stays separate: its body is the
 * multi-iteration tool loop, not a one-shot persist, so forcing it through here
 * would couple things that genuinely differ.
 *
 * Like the chat relay, the recorder runs independently of the client connection:
 * a disconnect mid-generation doesn't abort the work, so the media still lands
 * and the recovery flow picks it up.
 */

import { linkMessageMedia } from '../db/queries/media';
import { appendMessage } from '../db/queries/messages';
import { acquireEndpointSlot, type EndpointSlot } from '../endpoints/concurrency';
import type { LoadedEndpoint } from '../endpoints/config';
import { notifyConversationComplete, type NotifyModality } from '../push/notify';
import { raceTitle, startTitleTaskIfFirstExchange } from '../tasks/title-task-runner';
import { errorMessage, isAbortError, sseWriter, type SseWriter } from './sse-transport';
import type {
	ChatMessage,
	MessagePart,
	StreamDoneEvent,
	StreamErrorEvent,
	StreamStartEvent,
	StreamTitleEvent,
} from '$lib/types/api';

// Title gen has been running since generation started (the prompt is the
// topic), so it's almost always ready by the time the asset lands — a short
// budget keeps a slow task model from delaying `done`.
const TITLE_DELIVERY_BUDGET_MS = 5_000;

/** The lifecycle params shared by every media relay. The modality-specific
 *  inputs (upstream model id, prompt, input images, video poll knobs) are
 *  captured by the `generate` closure the caller passes, not here. */
export interface MediaRelayParams {
	conversationId: string;
	userId: string;
	conversationTitle: string | null;
	endpoint: LoadedEndpoint;
	/** The conversation-facing model id (recorded via modelUsed). */
	storedModelId: string;
	userMessage: ChatMessage;
	/** Split-attachments provenance: the (first) input image this generation
	 *  edits / animates, or null for text-to-media. Recorded on the durable error
	 *  sibling so a FAILED branch keeps its input thumbnail in a recovered grid —
	 *  the success path carries the same provenance on the output media row, which
	 *  a failure never produces. */
	sourceMediaId?: string | null;
	abortSignal?: AbortSignal;
	/** Fan-out branch: persist as a sibling without advancing active_leaf. */
	advanceActiveLeaf?: boolean;
	/** Skip the first-exchange title task (a fan-out runs it once in /prepare). */
	suppressTitleTask?: boolean;
	/** Skip this branch's own completion notification. An initial fan-out branch
	 *  passes true so the N branches don't each notify; the route fires one
	 *  aggregate "N ready" when the last settles. A regenerate leaves it false. */
	suppressNotify?: boolean;
	/** Optional pre-slot step (e.g. image prompt enhancement) that runs BEFORE
	 *  the endpoint concurrency slot is acquired, so a slow / different-endpoint
	 *  CPU step doesn't hold the generation slot (and can pipeline with another
	 *  branch's generation). Gets the SSE writer (to emit a transient status,
	 *  which a fan-out also uses to release the next branch's dispatch) and the
	 *  abort signal. An ABORT throw is treated as a Stop (the relay emits Cancelled
	 *  and closes); any OTHER throw is logged and generation proceeds with whatever
	 *  the prepare left in place. A normal return proceeds to slot acquisition. */
	prepare?: (ctx: { write: SseWriter['write']; abortSignal?: AbortSignal }) => Promise<void>;
	/** Fires when generation actually begins (slot acquired) — the route stamps
	 *  the in-flight entry so a recovered fan-out can show QUEUED vs timer. */
	onStarted?: () => void;
	/** Fires when the relay truly finishes — the route clears the in-flight slot. */
	onComplete: () => void;
	/**
	 * Fires when the GENERATION settles — media persisted, `done` written —
	 * which is earlier than `onComplete`: the stream stays open past this point
	 * for the auto-title race, so `onComplete` trails by up to
	 * TITLE_DELIVERY_BUDGET_MS. The route frees the in-flight registry entry
	 * here, since "in flight" means a generation is running and by now none is.
	 * Matters most for media: a video is exactly the thing a user walks away
	 * from, so a registry that lingers through the title task is what the
	 * sidebar's generating dot would keep reporting.
	 */
	onGenerationSettled?: () => void;
}

/** What a modality's generate step yields on success. The scaffold persists it
 *  as the assistant sibling. */
export interface GeneratedMedia {
	part: MessagePart;
	mediaId: string;
	rawResponseJson: string;
	modality: NotifyModality;
}

/** What a modality's generate step yields when it FAILED (as opposed to a
 *  user-initiated cancel). The step does NOT emit the `error` frame itself: the
 *  scaffold persists a durable error sibling first (so a fan-out grid recovered
 *  after a disconnect shows the branch as a failed column rather than dropping
 *  it) and then emits the frame carrying that row's id, which is what lets the
 *  live grid's discard button delete the failure instead of only hiding it.
 *  A user-initiated cancel still writes its own `Cancelled` frame and returns
 *  null — nothing is persisted, so there's no id to wait for. */
export interface MediaFailure {
	error: string;
}

/** The modality-specific core. Runs with the endpoint slot held and after
 *  `start` has been emitted: do the upstream generation (one-shot, or a poll
 *  loop emitting `progress` via `write`), persist the bytes through the
 *  MediaStore, and return the produced media. On a genuine failure, return a
 *  {@link MediaFailure} WITHOUT writing an `error` frame — the scaffold persists
 *  the durable error sibling and then emits the frame carrying its id. On a
 *  user-initiated cancel (Stop), emit the cancel event and return null to bail
 *  quietly without persisting anything. */
export type MediaGenerate = (ctx: {
	write: SseWriter['write'];
	abortSignal?: AbortSignal;
}) => Promise<GeneratedMedia | MediaFailure | null>;

export function startMediaRelay(
	params: MediaRelayParams,
	generate: MediaGenerate,
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			const { write: safeWrite, close: safeClose } = sseWriter(controller);
			let slot: EndpointSlot | null = null;
			try {
				// Pre-slot prepare phase (e.g. prompt enhancement). Runs OFF this
				// endpoint's slot so a slow / cross-endpoint CPU step doesn't hold the
				// generation slot — it manages its own concurrency (and serializes
				// against generation only when they share an endpoint). A Stop during
				// it surfaces as a cancellation (no slot held yet); any other failure
				// is swallowed by the prepare itself and we proceed with what we have.
				if (params.prepare) {
					try {
						await params.prepare({ write: safeWrite, abortSignal: params.abortSignal });
					} catch (e) {
						if (isAbortError(e) || params.abortSignal?.aborted) {
							safeWrite({ type: 'error', message: 'Cancelled' } satisfies StreamErrorEvent);
							safeClose();
							return;
						}
						// Non-abort: best-effort — log and proceed to generation.
						console.warn('[media-relay] prepare step failed (continuing):', errorMessage(e));
					}
				}

				// Hold a per-endpoint slot across the whole generation so a
				// single-GPU backend serializes; emit `queued` while waiting.
				try {
					slot = await acquireEndpointSlot(params.endpoint.id, params.endpoint.maxConcurrent, {
						signal: params.abortSignal,
						onQueued: ({ ahead }) => safeWrite({ type: 'queued', ahead }),
					});
				} catch (e) {
					// Stop clicked while queued — nothing started; surface as a
					// cancellation. No slot held, so the finally's release no-ops.
					safeWrite({
						type: 'error',
						message: isAbortError(e) || params.abortSignal?.aborted ? 'Cancelled' : errorMessage(e),
					} satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				// Slot acquired → generation begins. `start` flips the client column
				// from QUEUED to a live timer; onStarted stamps the in-flight entry so
				// a recovery rebuild can do the same.
				params.onStarted?.();
				// Generation clock starts here — after the queue wait, so the
				// recorded time is decode/render only, not slot contention.
				const genStartedAt = Date.now();
				safeWrite({
					type: 'start',
					userMessage: params.userMessage,
					assistantMessageId: '',
				} satisfies StreamStartEvent);

				const titlePromise = params.suppressTitleTask
					? Promise.resolve<string | null>(null)
					: startTitleTaskIfFirstExchange(params.conversationId, params.userId);

				// Modality-specific: produce + persist the media bytes. Returns null
				// after emitting its own cancel event — bail quietly. Returns a
				// MediaFailure WITHOUT emitting an error event — the scaffold below
				// persists a durable error sibling (so a recovered fan-out can still
				// show it) and only then emits the frame, carrying that row's id.
				const produced = await generate({ write: safeWrite, abortSignal: params.abortSignal });
				if (!produced) {
					safeClose();
					return;
				}
				if ('error' in produced) {
					// A genuine failure (not a Stop). Persist a durable record so the
					// branch survives a client disconnect. Without this, the relay's
					// `finally` clears the in-flight slot and the branch leaves no trace
					// — a fan-out grid recovered after an iOS suspend would silently drop
					// the column (and a lone branch's grid would evaporate to just the
					// prompt). advanceActiveLeaf mirrors the success path: a fan-out
					// branch stays a pinned sibling (recovery rebuilds the failed column);
					// a single send advances the leaf so the failure shows in the thread.
					// `sourceMediaId` is the split-attachments input, which only the error
					// part can carry — the success path reads it off the output media row.
					let persistedId: string | undefined;
					try {
						persistedId = appendMessage({
							conversationId: params.conversationId,
							parentMessageId: params.userMessage.id,
							role: 'assistant',
							parts: [
								{
									type: 'error',
									message: produced.error,
									sourceMediaId: params.sourceMediaId ?? null,
								},
							],
							modelUsed: params.storedModelId,
							genMs: Date.now() - genStartedAt,
							advanceActiveLeaf: params.advanceActiveLeaf ?? true,
						}).id;
					} catch (e) {
						// Best-effort durability — the client still gets the error frame
						// below, just without a handle to the (absent) row.
						console.warn('[media-relay] failed to persist error sibling:', errorMessage(e));
					}
					// The terminal `error` frame is emitted HERE, not by the generate step,
					// so it can carry the persisted row's id: a fan-out column that fails
					// is a real server-side row, and the grid's discard button has to
					// delete it or a "removed" failure reappears on the next reload.
					safeWrite({
						type: 'error',
						message: produced.error,
						messageId: persistedId,
					} satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				let assistantMessage: ChatMessage;
				try {
					assistantMessage = appendMessage({
						conversationId: params.conversationId,
						parentMessageId: params.userMessage.id,
						role: 'assistant',
						parts: [produced.part],
						modelUsed: params.storedModelId,
						rawResponseJson: produced.rawResponseJson,
						genMs: Date.now() - genStartedAt,
						advanceActiveLeaf: params.advanceActiveLeaf ?? true,
					});
					linkMessageMedia(assistantMessage.id, produced.mediaId);
				} catch (e) {
					safeWrite({ type: 'error', message: errorMessage(e) } satisfies StreamErrorEvent);
					safeClose();
					return;
				}

				// A fan-out branch suppresses its own notify; the route fires one
				// aggregate "N ready" when the last branch settles.
				if (!params.suppressNotify) {
					void notifyConversationComplete({
						userId: params.userId,
						conversationId: params.conversationId,
						assistantMessageId: assistantMessage.id,
						conversationTitle: params.conversationTitle ?? 'New conversation',
						previewText: '',
						modality: produced.modality,
					}).catch((e) => console.warn('[media-relay] notify failed:', e));
				}

				safeWrite({ type: 'done', assistantMessage } satisfies StreamDoneEvent);
				// Generation + persistence are done — free the endpoint slot BEFORE the
				// title race, not after. The title task is gated on the same endpoint
				// slot now (see callTaskModel), so on a single-GPU (max_concurrent=1)
				// endpoint holding the slot here would block the title task from ever
				// being granted → raceTitle would burn its whole budget and the next
				// queued generation would wait it out. The finally is the idempotent
				// backstop for the early-return / error paths.
				slot?.release();
				// Same boundary for the in-flight registry: generation is over, so
				// stop reporting it as running rather than holding the entry through
				// the title race. Identity-guarded, so the finally's onComplete stays
				// a harmless no-op (and can't clobber a fast follow-up's entry).
				params.onGenerationSettled?.();
				const title = await raceTitle(titlePromise, TITLE_DELIVERY_BUDGET_MS);
				if (title) safeWrite({ type: 'title', title } satisfies StreamTitleEvent);
				safeClose();
			} finally {
				slot?.release();
				params.onComplete();
			}
		},
	});
}
