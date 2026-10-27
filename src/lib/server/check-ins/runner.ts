/**
 * The check-in runner: fires each check-in that has come due.
 *
 * Firing appends the reminder — a user-role message flagged `checkIn`, telling
 * the model what time it is and what it meant to do — under the end of the
 * thread, then runs an ordinary chat turn on it the way a scheduled task does:
 * nobody connected, `background` priority, through the same `startChatTurn` a
 * send uses. Its reply is the message that arrives out of the blue, and the push
 * notification is what makes it feel like one.
 *
 * A check-in only fires if the thread is still where the reply that set it left
 * it: that reply, or a photo it sent, is the end of the active branch. Anything
 * else — the user answered, regenerated, switched branches, deleted the reply —
 * means the moment has passed, and the row is dropped. While something else is
 * running in the conversation (a turn, a photo being developed, an open
 * comparison) it waits, up to a grace period; a check-in hours late after a
 * restart would arrive at the wrong moment, so past that it's dropped too.
 *
 * The model may also decline: the reminder tells it to answer `[no text]` if
 * the moment has gone, and a reply like that (or a turn that produced nothing)
 * is taken back out of the thread, reminder included, as if it never fired.
 */
import { partsToText } from '#lib/message-parts.js';
import type { ReplyStyle } from '#lib/types/api.js';
import { friendlyModelName } from '#lib/model-ids.js';
import { photoChain } from '#lib/texting-photos.js';
import { extractPlainSpeaker, photoDescription } from '#lib/texting.js';
import { CHECK_IN_SKIP, checkInMarker, isCheckInSkip } from '#lib/check-ins.js';
import {
	listDueCheckIns,
	deleteCheckInIfUnchanged,
	type CheckInRow,
} from '../db/queries/check-ins';
import {
	getConversationCustomModelId,
	getConversationMeta,
	getFanoutParent,
} from '../db/queries/conversations';
import { getCustomModelForUser } from '../db/queries/custom-models';
import {
	appendMessage,
	deleteBranch,
	getActiveLeafMessageId,
	getMessage,
	restoreActiveLeafIfUnchanged,
	walkActiveBranch,
} from '../db/queries/messages';
import { getUserPreferences } from '../db/queries/user-preferences';
import { getCheckInsConfig } from '../endpoints/config';
import { parseModelId } from '../endpoints/model-id';
import { getEndpoint } from '../endpoints/registry';
import { buildPreview, notifyConversationComplete } from '../push/notify';
import { startChatTurn } from '../chat/start-turn';
import { resolveTimeZone } from '../chat/environment-context';
import {
	clearInFlight,
	getAvatarDrawSince,
	getInFlightSince,
	registerInFlight,
} from '../streaming/in-flight';
import type { TurnOutcome } from '../streaming/relay';
import { errorMessage } from '../streaming/sse-transport';
import { createLogger } from '../log';
import { createSweeper } from '../util/sweeper';

const log = createLogger('check-ins');

const TICK_MS = 30_000;
const INITIAL_DELAY_MS = 20_000;
/** Check-ins fired or dropped per tick. Each fire only starts a turn (it
 *  queues on the gate), so this bounds the tick's own work, not GPU load. */
const MAX_FIRES_PER_TICK = 20;
/** Rows looked at per tick, waiting ones included. Waiting rows are paged past
 *  rather than counted against the fires, so a pile of them (one user with many
 *  busy conversations) can't keep everyone else's from being reached. */
const MAX_SCANNED_PER_TICK = 500;
const PAGE_SIZE = 50;
const MIN_GRACE_MS = 30 * 60_000;

/** How late a check-in may still fire: half an hour, or a quarter of its delay
 *  if that's longer — a day's wait can stand to be a few hours late; an
 *  hour's can't. */
export function graceFor(row: Pick<CheckInRow, 'fireAt' | 'createdAt'>): number {
	return Math.max(MIN_GRACE_MS, (row.fireAt - row.createdAt) / 4);
}

let running = false;

/**
 * One tick: tries every due check-in. Returns how many fired. Safe to call
 * directly (tests do); re-entrant calls return 0.
 */
export async function runCheckInSweep(now = Date.now()): Promise<number> {
	if (running) return 0;
	running = true;
	try {
		let fired = 0;
		let handled = 0;
		let scanned = 0;
		let cursor: CheckInRow | undefined;
		while (handled < MAX_FIRES_PER_TICK && scanned < MAX_SCANNED_PER_TICK) {
			const page = listDueCheckIns(now, PAGE_SIZE, cursor);
			for (const row of page) {
				if (handled >= MAX_FIRES_PER_TICK) break;
				scanned++;
				let result: FireResult;
				try {
					result = fireCheckIn(row, now);
				} catch (e) {
					log.warn(`check-in for ${row.conversationId} failed to fire:`, errorMessage(e));
					result = 'drop';
				}
				if (result === 'fired') {
					fired++;
					handled++;
				} else if (result === 'drop' || now > row.fireAt + graceFor(row)) {
					deleteCheckInIfUnchanged(row.id, row.fireAt);
					handled++;
				}
			}
			if (page.length < PAGE_SIZE) break;
			cursor = page.at(-1);
		}
		return fired;
	} finally {
		running = false;
	}
}

type FireResult = 'fired' | 'wait' | 'drop';

/**
 * Fire one check-in, or say why not. Synchronous up to the turn's start — the
 * branch is read and the reminder appended with no await between, so nothing
 * can land in the thread in between.
 */
function fireCheckIn(row: CheckInRow, now: number): FireResult {
	if (!getCheckInsConfig().enabled) return 'drop';
	const { conversationId, userId } = row;
	const meta = getConversationMeta(conversationId, userId);
	if (!meta || !meta.checkIns) return 'drop';
	if (
		getInFlightSince(conversationId) !== null ||
		getAvatarDrawSince(conversationId) !== null ||
		getFanoutParent(conversationId, userId) !== null
	) {
		return 'wait';
	}
	const branch = walkActiveBranch(conversationId, { columns: 'serialization' });
	const leaf = branch.at(-1);
	if (!leaf || photoChain(branch)?.replyId !== row.sourceMessageId) return 'drop';
	const model = parseModelId(meta.modelId);
	const endpoint = model && getEndpoint(model.endpointId);
	if (!model || !endpoint) return 'drop';

	// Gone before the turn starts, so a second tick can't fire it again.
	deleteCheckInIfUnchanged(row.id, row.fireAt);
	const prefs = getUserPreferences(userId);
	const reminder = appendMessage({
		conversationId,
		parentMessageId: leaf.id,
		role: 'user',
		parts: [
			{
				type: 'text',
				text: reminderText(row, now, prefs?.timezone ?? null, meta.replyStyle),
				checkIn: true,
			},
		],
		advanceActiveLeafIfCurrent: leaf.id,
	});

	const inFlight = registerInFlight(conversationId, endpoint, undefined, 'chat', meta.modelId);
	inFlight.background = true;
	const settle = (outcome: TurnOutcome) => {
		try {
			settleCheckIn(row, reminder.id, leaf.id, outcome);
		} catch (e) {
			log.warn(`check-in for ${conversationId} failed while settling:`, errorMessage(e));
		}
	};
	startChatTurn({
		conversationId,
		userId,
		meta,
		endpoint,
		model,
		disabledFeatures: meta.disabledFeatures,
		inFlight,
		userMessage: reminder,
		allowTools: true,
		slotPriority: 'background',
		// Notified from settleCheckIn, which knows whether the model passed.
		suppressNotify: true,
		suppressTitleTask: true,
		onGenerationSettled: () => clearInFlight(conversationId, inFlight),
		onComplete: () => clearInFlight(conversationId, inFlight),
		onOutcome: settle,
	})
		// Nobody reads the stream: cancel it so frames don't pile up in its queue.
		.then((stream) => stream.cancel())
		.catch((e: unknown) => {
			clearInFlight(conversationId, inFlight);
			log.warn(`check-in turn for ${conversationId} failed to start:`, errorMessage(e));
			settle({ kind: 'stopped' });
		});
	return 'fired';
}

/** What the model is told when its check-in comes due. */
export function reminderText(
	row: Pick<CheckInRow, 'note' | 'createdAt'>,
	now: number,
	timeZone: string | null,
	style: ReplyStyle = 'texting',
): string {
	const when = new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		hour: 'numeric',
		minute: '2-digit',
		timeZone: resolveTimeZone(timeZone),
	}).format(now);
	const minutes = Math.max(1, Math.round((now - row.createdAt) / 60_000));
	const elapsed =
		minutes < 90
			? `${minutes} minute${minutes === 1 ? '' : 's'}`
			: `${Math.round(minutes / 60)} hours`;
	const note = row.note.replace(/[.!\s]+$/, '');
	const [last, act] =
		style === 'texting' ? ['text', 'Text them now'] : ['message', 'Reach out now'];
	return (
		`(Check-in: it's ${when}, ${elapsed} since your last ${last}, and they haven't replied. ` +
		`You meant to: ${note}. ${act} if it still fits; if it no longer makes sense, ` +
		`reply with only ${CHECK_IN_SKIP}.)`
	);
}

/** After the turn: take a pass (or nothing) back out, or notify. */
function settleCheckIn(
	row: CheckInRow,
	reminderId: string,
	previousLeafId: string,
	outcome: TurnOutcome,
): void {
	const { conversationId, userId } = row;
	if (outcome.kind === 'error' || outcome.kind === 'halted_for_approval') return;
	const reply =
		outcome.kind === 'done' ? getMessage(conversationId, outcome.assistantMessageId) : null;
	if (reply && !isCheckInSkip(partsToText(reply.parts))) {
		void notifyCheckIn(row, reply.id, replyText(reply.parts)).catch((e: unknown) =>
			log.warn('notify failed:', errorMessage(e)),
		);
		return;
	}
	// Only while the thread still ends at the reminder or its reply: the user
	// may have sent something meanwhile (which stopped this turn), and that
	// hangs under the reminder too.
	const leaf = getActiveLeafMessageId(conversationId, userId);
	const leafRow = leaf ? getMessage(conversationId, leaf) : null;
	const ownLeaf =
		leaf === reminderId ||
		(leafRow?.role === 'assistant' && leafRow.parentMessageId === reminderId);
	if (!leaf || !ownLeaf) return;
	restoreActiveLeafIfUnchanged(conversationId, leaf, previousLeafId);
	deleteBranch(conversationId, reminderId, userId);
}

/** A reply's texts, without the markers that aren't texts — for deciding
 *  whether it said anything, and for the notification's preview. */
function replyText(parts: Parameters<typeof partsToText>[0]): string {
	return partsToText(parts)
		.split(/\n\s*\n/)
		.filter((p) => {
			const text = extractPlainSpeaker(p.trim());
			return text.text && !checkInMarker(text) && photoDescription(text) === null;
		})
		.join('\n\n');
}

async function notifyCheckIn(row: CheckInRow, replyId: string, text: string): Promise<void> {
	const { conversationId, userId } = row;
	const meta = getConversationMeta(conversationId, userId);
	if (!meta) return;
	const presetId = getConversationCustomModelId(conversationId, userId);
	const sender =
		(presetId && getCustomModelForUser(presetId, userId)?.name) || friendlyModelName(meta.modelId);
	await notifyConversationComplete({
		userId,
		conversationId,
		assistantMessageId: replyId,
		conversationTitle: sender,
		previewText: buildPreview(text),
		modality: 'chat',
	});
}

const sweeper = createSweeper({
	name: 'check-ins',
	intervalMs: TICK_MS,
	initialDelayMs: INITIAL_DELAY_MS,
	enabled: () => getCheckInsConfig().enabled,
	sweep: () => runCheckInSweep(),
});

export const startCheckInRunner = (): void => sweeper.start();
export const stopCheckInRunner = (): void => sweeper.stop();
