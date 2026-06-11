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
 *   → regenerate replace-delete (server-side, survives a refresh mid-re-roll)
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
	abortSignal?: AbortSignal;
	/** Fan-out branch: persist as a sibling without advancing active_leaf. */
	advanceActiveLeaf?: boolean;
	/** Skip the first-exchange title task (a fan-out runs it once in /prepare). */
	suppressTitleTask?: boolean;
	/** Skip this branch's own completion notification. An initial fan-out branch
	 *  passes true so the N branches don't each notify; the route fires one
	 *  aggregate "N ready" when the last settles. A regenerate leaves it false. */
	suppressNotify?: boolean;
	/** Fires when generation actually begins (slot acquired) — the route stamps
	 *  the in-flight entry so a recovered fan-out can show QUEUED vs timer. */
	onStarted?: () => void;
	/** Fires when the relay truly finishes — the route clears the in-flight slot. */
	onComplete: () => void;
}

/** What a modality's generate step yields on success. The scaffold persists it
 *  as the assistant sibling. Returning null means the step already emitted its
 *  own error/cancel event and the relay should bail quietly. */
export interface GeneratedMedia {
	part: MessagePart;
	mediaId: string;
	rawResponseJson: string;
	modality: NotifyModality;
}

/** The modality-specific core. Runs with the endpoint slot held and after
 *  `start` has been emitted: do the upstream generation (one-shot, or a poll
 *  loop emitting `progress` via `write`), persist the bytes through the
 *  MediaStore, and return the produced media — or emit an error/cancel event and
 *  return null. */
export type MediaGenerate = (ctx: {
	write: SseWriter['write'];
	abortSignal?: AbortSignal;
}) => Promise<GeneratedMedia | null>;

export function startMediaRelay(
	params: MediaRelayParams,
	generate: MediaGenerate,
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			const { write: safeWrite, close: safeClose } = sseWriter(controller);
			let slot: EndpointSlot | null = null;
			try {
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
					: startTitleTaskIfFirstExchange(params.conversationId);

				// Modality-specific: produce + persist the media bytes. Returns null
				// after emitting its own error/cancel — bail quietly.
				const produced = await generate({ write: safeWrite, abortSignal: params.abortSignal });
				if (!produced) {
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
