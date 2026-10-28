import { describe, expect, it } from 'vitest';
import {
	checkInMarker,
	isCheckInMessage,
	isCheckInSkip,
	MAX_CHECK_IN_DELAY_MS,
	MIN_CHECK_IN_DELAY_MS,
	parseDelay,
} from '#lib/check-ins.js';
import { checkInSetBy, replyCheckIn, withoutCheckInText } from '#lib/texting-check-ins.js';
import { textingItems, withoutCheckInMarkers } from '#lib/texting.js';
import type { ChatMessage, MessagePart } from '#lib/types/api.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('parseDelay', () => {
	it.each([
		['1h', HOUR],
		['90m', 90 * MIN],
		['1h 30m', 90 * MIN],
		['1h30m', 90 * MIN],
		['2h15min', 135 * MIN],
		['1 hour and 30 minutes', 90 * MIN],
		['2 hours', 2 * HOUR],
		['1.5h', 90 * MIN],
		['in 45 mins', 45 * MIN],
		['1d', 24 * HOUR],
	])('reads %s', (input, ms) => expect(parseDelay(input)).toBe(ms));

	it('clamps to the allowed range', () => {
		expect(parseDelay('1m')).toBe(MIN_CHECK_IN_DELAY_MS);
		expect(parseDelay('3 days')).toBe(MAX_CHECK_IN_DELAY_MS);
	});

	it.each(['soon', 'tomorrow', '1h-ish', '', '0m'])('rejects %j', (input) =>
		expect(parseDelay(input)).toBeNull(),
	);
});

describe('checkInMarker', () => {
	it('keeps a note to a line or two', () => {
		const note = checkInMarker({ text: `[later 1h: ${'x'.repeat(1000)}]` })?.note;
		expect(note).toHaveLength(280);
	});

	it('reads a plain or emphasized marker', () => {
		expect(checkInMarker({ text: '[later 1h: ask about work]' })).toEqual({
			delayMs: HOUR,
			note: 'ask about work',
		});
		expect(checkInMarker({ text: '*[Later 2h: check in]*' })?.delayMs).toBe(2 * HOUR);
		expect(checkInMarker({ html: '<p><em>[later 30m: ping &amp; ask]</em></p>' })).toEqual({
			delayMs: 30 * MIN,
			note: 'ping & ask',
		});
	});

	it('is not a marker when the delay is not one, or there is more text', () => {
		expect(checkInMarker({ text: '[later tonight: ask]' })).toBeNull();
		expect(checkInMarker({ text: 'ttyl [later 1h: ask]' })).toBeNull();
		expect(checkInMarker({ text: '[later 1h: ]' })).toBeNull();
	});
});

describe('isCheckInSkip', () => {
	it.each(['[no text]', ' *[No text]* ', ''])('%j passes', (t) =>
		expect(isCheckInSkip(t)).toBe(true),
	);
	it('anything said is not a pass', () => expect(isCheckInSkip('hey [no text]')).toBe(false));
});

function msg(id: string, role: ChatMessage['role'], parts: MessagePart[]): ChatMessage {
	return {
		id,
		role,
		parts,
		contentHtml: null,
		reasoningText: null,
		finishReason: null,
		modelUsed: null,
		tokensIn: null,
		tokensOut: null,
		genMs: null,
		createdAt: 0,
	};
}
const say = (id: string, role: ChatMessage['role'], text: string) =>
	msg(id, role, [{ type: 'text', text }]);
const reminder = (id: string) => msg(id, 'user', [{ type: 'text', text: '(…)', checkIn: true }]);

describe('replyCheckIn', () => {
	it('takes the last marker, even one signed with a name', () => {
		expect(replyCheckIn('[later 1h: a]\n\nok\n\nChloe: [later 2h: b]')).toEqual({
			delayMs: 2 * HOUR,
			note: 'b',
		});
		expect(replyCheckIn('no marker here')).toBeNull();
	});
});

describe('checkInSetBy', () => {
	const marked = 'brb\n\n[later 1h: ask]';

	it("reads the reply's marker", () => {
		const branch = [say('u', 'user', 'hi'), say('a', 'assistant', marked)];
		expect(checkInSetBy(branch, 'a')?.note).toBe('ask');
	});

	it('allows one more after a check-in, but not a third in a row', () => {
		const once = [say('u', 'user', 'hi'), say('a', 'assistant', 'x'), reminder('r1')];
		expect(checkInSetBy([...once, say('b', 'assistant', marked)], 'b')).not.toBeNull();
		const twice = [...once, say('b', 'assistant', 'x'), reminder('r2')];
		expect(checkInSetBy([...twice, say('c', 'assistant', marked)], 'c')).toBeNull();
	});

	it('counts afresh once the user answers', () => {
		const branch = [
			say('a', 'assistant', 'x'),
			reminder('r1'),
			say('b', 'assistant', 'x'),
			reminder('r2'),
			say('c', 'assistant', 'x'),
			say('u', 'user', 'back'),
			say('d', 'assistant', marked),
		];
		expect(checkInSetBy(branch, 'd')).not.toBeNull();
	});

	it('only reads assistant replies on the branch', () => {
		expect(checkInSetBy([say('u', 'user', marked)], 'u')).toBeNull();
		expect(checkInSetBy([], 'gone')).toBeNull();
	});
});

describe('isCheckInMessage', () => {
	it('is the flagged user row only', () => {
		expect(isCheckInMessage(reminder('r'))).toBe(true);
		expect(isCheckInMessage(say('u', 'user', 'hi'))).toBe(false);
	});
});

describe('textingItems', () => {
	it('sets a marker apart without renumbering the photos after it', () => {
		const items = textingItems(
			[
				{
					type: 'html',
					html: '<p>[later 1h: ask]</p>\n<p>[photo: a cat]</p>',
				},
			],
			'Chloe',
		);
		expect(items).toEqual([
			{ kind: 'later', delayMs: HOUR, note: 'ask' },
			{ kind: 'photo', speaker: null, description: 'a cat', index: 0 },
		]);
	});
});

describe('withoutCheckInMarkers', () => {
	it('drops the marker from a standard reply, rendered or live', () => {
		expect(
			withoutCheckInMarkers([{ type: 'html', html: '<p>Good luck!</p>\n<p>[later 1h: ask]</p>' }]),
		).toEqual([{ type: 'html', html: '<p>Good luck!</p>' }]);
		expect(
			withoutCheckInMarkers([{ type: 'plain-text', text: 'Good luck!\n\n[later 1h: ask]' }]),
		).toEqual([{ type: 'plain-text', text: 'Good luck!' }]);
	});

	it('leaves a reply without one untouched', () => {
		const blocks = [{ type: 'html' as const, html: '<p>see you [later], maybe</p>' }];
		expect(withoutCheckInMarkers(blocks)).toEqual(blocks);
	});
});

describe('withoutCheckInText', () => {
	it('drops marker paragraphs, signed or not, and nothing else', () => {
		expect(withoutCheckInText('good luck!\n\nChloe: [later 2h: ask]')).toBe('good luck!');
		expect(withoutCheckInText('[later 2h: ask]')).toBe('');
		expect(withoutCheckInText('see you [later], maybe')).toBe('see you [later], maybe');
	});
});
