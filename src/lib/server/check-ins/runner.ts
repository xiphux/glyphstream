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
 * it: that reply is the end of the active branch. Anything else — the user
 * answered, regenerated, switched branches, deleted the reply — means the
 * moment has passed, and the row is dropped. While something else is running
 * in the conversation (a turn, an open comparison) it
 * waits, up to a grace period; a check-in hours late after a
 * restart would arrive at the wrong moment, so past that it's dropped too.
 *
 * The model may also decline: the reminder tells it to answer `[no text]` if
 * the moment has gone, and a reply like that (or a turn stopped before it
 * said anything, or one still queued when its grace ran out) is taken back out
 * of the thread, reminder included, as if it never fired. A turn that failed
 * is left in place, error and all; a reply stopped partway stays as it is.
 */
import { partsToText } from '#lib/message-parts.js';
import { isReactionTool, lastReplyMessage, parseReactionEmoji } from '#lib/chat-render.js';
import type { ChatMessage, ReplyStyle } from '#lib/types/api.js';
import { friendlyModelName } from '#lib/model-ids.js';
import { withoutCheckInText } from '#lib/texting-check-ins.js';
import { extractPlainSpeaker, photoDescription } from '#lib/texting.js';
import { CHECK_IN_SKIP, checkInMarker, graceFor, isCheckInSkip } from '#lib/check-ins.js';
import {
	listDueCheckIns,
	deleteCheckInIfUnchanged,
	type CheckInRow,
} from '../db/queries/check-ins';
import {
	getConversationCustomModelId,
	getConversationMeta,
	getConversationUpdatedAt,
	getFanoutParent,
	restoreConversationUpdatedAt,
} from '../db/queries/conversations';
import { getCustomModelForUser } from '../db/queries/custom-models';
import {
	appendMessage,
	deleteBranch,
	findUserMessageAncestor,
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
import { resolveDisabledFeatures } from '../chat/private-seal';
import { resolveTimeZone } from '../chat/environment-context';
import { clearInFlight, getInFlightSince, registerInFlight } from '../streaming/in-flight';
import type { TurnOutcome } from '../streaming/relay';
import { errorMessage } from '../streaming/sse-transport';
import { createLogger } from '../log';
import { createSweeper } from '../util/sweeper';
import { toolLabel } from '../scheduled/runner';

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
				// Too late to fire, however it would go: a restart, or an account
				// disabled meanwhile, can leave a check-in hours overdue.
				if (now > row.fireAt + graceFor(row)) {
					deleteCheckInIfUnchanged(row.id, row.fireAt);
					handled++;
					continue;
				}
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
				} else if (result === 'drop') {
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
		getFanoutParent(conversationId, userId) !== null
	) {
		return 'wait';
	}
	const branch = walkActiveBranch(conversationId, { columns: 'serialization' });
	const leaf = branch.at(-1);
	if (!leaf || lastReplyMessage(branch)?.id !== row.sourceMessageId) return 'drop';
	const model = parseModelId(meta.modelId);
	const endpoint = model && getEndpoint(model.endpointId);
	if (!model || !endpoint) return 'drop';

	// Gone before the turn starts, so a second tick can't fire it again.
	deleteCheckInIfUnchanged(row.id, row.fireAt);
	const updatedAt = getConversationUpdatedAt(conversationId, userId);
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
	// The grace bounds the wait in line too, as a scheduled task's deadline
	// does: a turn still queued past it would arrive at the wrong moment.
	// Aborting drops it out of line, and the `stopped` settle takes the reminder
	// back out. Once the slot is granted the reply finishes, however late.
	const deadline = setTimeout(
		() => {
			if (inFlight.generationStartedAt === null) inFlight.controller.abort();
		},
		Math.max(0, row.fireAt + graceFor(row) - now),
	);
	deadline.unref?.();
	const settle = (outcome: TurnOutcome) => {
		clearTimeout(deadline);
		try {
			settleCheckIn(row, reminder.id, leaf.id, updatedAt, outcome);
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
		disabledFeatures: resolveDisabledFeatures(meta),
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
	previousUpdatedAt: number | null,
	outcome: TurnOutcome,
): void {
	const { conversationId, userId } = row;
	if (outcome.kind === 'error') return;
	// Nobody is watching, and the relay's own push is suppressed: say the check-in
	// is waiting on them, or it sits on an approval prompt no one knows about.
	if (outcome.kind === 'halted_for_approval') {
		const summary = `Waiting for your OK to use ${toolLabel(outcome.pendingToolNames[0])}`;
		void notifyCheckIn(row, outcome.assistantMessageId, '', summary).catch((e: unknown) =>
			log.warn('notify failed:', errorMessage(e)),
		);
		return;
	}
	if (outcome.kind === 'done') {
		const reply = getMessage(conversationId, outcome.assistantMessageId);
		if (reply && !isPass(reply.parts)) {
			// A reply that only put the check-in off again ([later …] and nothing
			// else) stays, so its new check-in does. It has nothing to notify of
			// itself, but a line the turn wrote before a tool call does.
			if (!withoutCheckInText(partsToText(reply.parts)).trim()) {
				notifyTurn(row, turnRows(conversationId, reply.id, reminderId));
				return;
			}
			void notifyCheckIn(row, reply.id, replyText(reply.parts)).catch((e: unknown) =>
				log.warn('notify failed:', errorMessage(e)),
			);
			return;
		}
	}
	// Only while the thread still ends in this turn — the reminder, or the rows
	// its reply (tool calls included) hangs below it: the user may have sent
	// something meanwhile (which stopped this turn), and that hangs under the
	// reminder too.
	const leaf = getActiveLeafMessageId(conversationId, userId);
	if (!leaf || findUserMessageAncestor(conversationId, leaf)?.id !== reminderId) return;
	// Anything the turn said, reacted or made on the way stays, like any stopped reply:
	// the user pressed Stop on a reply they were reading, or the model wrote a
	// line before a tool call and only then passed. Only the pass after it goes
	// (a `[no text]` bubble would show, and be re-sent, as written).
	const rows = turnRows(conversationId, leaf, reminderId);
	if (rows.some((m) => !isPass(m.parts)) || reactions(rows).length > 0) {
		// Trailing replies that are only a pass, with no tool call a result
		// would answer: the rest of the turn ends where they began.
		let bare = 0;
		while (
			bare < rows.length &&
			rows[bare].role === 'assistant' &&
			isPass(rows[bare].parts) &&
			!rows[bare].parts.some((p) => p.type === 'tool_call')
		) {
			bare++;
		}
		if (bare > 0) {
			restoreActiveLeafIfUnchanged(conversationId, leaf, rows[bare].id);
			deleteBranch(conversationId, rows[bare - 1].id, userId, { recordRejection: false });
		}
		// A Stop was pressed by someone reading it, but a pass at the end of a
		// turn that said something first said it to nobody watching.
		if (outcome.kind === 'done') notifyTurn(row, rows);
		return;
	}
	restoreActiveLeafIfUnchanged(conversationId, leaf, previousLeafId);
	deleteBranch(conversationId, reminderId, userId, { recordRejection: false });
	if (previousUpdatedAt !== null) {
		restoreConversationUpdatedAt(conversationId, userId, previousUpdatedAt);
	}
}

/** Notify of what a turn said along the way (`rows` newest first, as
 *  `turnRows` gives them), if it said anything. */
function notifyTurn(row: CheckInRow, rows: ChatMessage[]): void {
	const said = rows
		.filter((m) => m.role === 'assistant' && !isPass(m.parts) && replyText(m.parts))
		.reverse();
	const latest = said.at(-1);
	if (!latest) {
		// Only a reaction — a wave, a face: that's what it said.
		const emoji = reactions(rows);
		const reacted = rows.find((m) => m.role === 'assistant' && hasReaction(m.parts));
		if (emoji.length > 0 && reacted) {
			void notifyCheckIn(row, reacted.id, emoji.join(' ')).catch((e: unknown) =>
				log.warn('notify failed:', errorMessage(e)),
			);
		}
		return;
	}
	const text = said.map((m) => replyText(m.parts)).join('\n\n');
	void notifyCheckIn(row, latest.id, text).catch((e: unknown) =>
		log.warn('notify failed:', errorMessage(e)),
	);
}

/** The emoji a turn reacted with (`rows` newest first, as `turnRows` gives
 *  them), oldest first. A check-in can answer with nothing else, which says as
 *  much as a text would, so a turn that reacted isn't a pass — unless the
 *  reacting row also wrote the pass marker. One the tool refused never happened; one whose result is missing did (the thread draws
 *  it the same way — see `buildRenderedConversation`). */
function reactions(rows: ChatMessage[]): string[] {
	const refused = new Set(
		rows.flatMap((m) =>
			m.parts.flatMap((p) => (p.type === 'tool_result' && p.isError ? [p.toolCallId] : [])),
		),
	);
	return rows
		.filter((m) => m.role === 'assistant' && !declines(m))
		.reverse()
		.flatMap((m) =>
			m.parts.flatMap((p) => {
				if (p.type !== 'tool_call' || !isReactionTool(p.toolName)) return [];
				if (refused.has(p.toolCallId)) return [];
				return parseReactionEmoji(p.arguments) ?? [];
			}),
		);
}

/** A row that wrote the pass marker itself, rather than nothing: whatever it
 *  reacted with on the way, the model said it was passing. (The empty row the
 *  reaction tool's second round often ends with is not one.) */
function declines(m: ChatMessage): boolean {
	const text = partsToText(m.parts).trim();
	return text !== '' && isCheckInSkip(text);
}

function hasReaction(parts: ChatMessage['parts']): boolean {
	return parts.some((p) => p.type === 'tool_call' && isReactionTool(p.toolName));
}

/** The rows from `leaf` up to (not including) the reminder: one turn's
 *  replies, tool calls and results. Bounded by the tool loop, so a walk. */
function turnRows(conversationId: string, leaf: string, reminderId: string): ChatMessage[] {
	const rows: ChatMessage[] = [];
	let cursor = getMessage(conversationId, leaf);
	while (cursor && cursor.id !== reminderId) {
		rows.push(cursor);
		cursor = cursor.parentMessageId ? getMessage(conversationId, cursor.parentMessageId) : null;
	}
	return rows;
}

/** Whether a row says nothing: a `[no text]` pass or no text at all (a tool
 *  call or its result), and no media either. */
function isPass(parts: ChatMessage['parts']): boolean {
	return isCheckInSkip(partsToText(parts)) && !parts.some((p) => 'mediaId' in p);
}

/** A reply's texts, without the markers that aren't texts (photos' too) —
 *  for the notification's preview. */
function replyText(parts: Parameters<typeof partsToText>[0]): string {
	return partsToText(parts)
		.split(/\n\s*\n/)
		.filter((p) => {
			const text = extractPlainSpeaker(p.trim());
			return text.text && !checkInMarker(text) && photoDescription(text) === null;
		})
		.join('\n\n');
}

async function notifyCheckIn(
	row: CheckInRow,
	replyId: string,
	text: string,
	summary?: string,
): Promise<void> {
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
		...(summary ? { summary } : {}),
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
