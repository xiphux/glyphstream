/**
 * `get_current_time` — the v1 proof-of-concept tool. Returns the current
 * date+time, optionally in a caller-specified IANA timezone. Uses the
 * built-in `Intl.DateTimeFormat` for timezone validation + formatting so
 * there are zero new dependencies.
 *
 * Invalid timezones return `{ isError: true }` rather than throwing, so
 * the model receives the error in-band and can self-correct (e.g. fall
 * back to UTC or apologize to the user).
 */

import { register } from './registry';
import type { Tool } from './types';
import { resolveTimeZone } from '../chat/environment-context';
import { getUserPreferences } from '../db/queries/user-preferences';

export const clockTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'get_current_time',
			// Today's date is already in the system prompt (see environment-context.ts),
			// so the common case — "what's today?" — needs no round-trip at all. Say so,
			// or the model burns a full prefill+decode rediscovering what it was handed.
			description:
				'Get the current time of day, or the date/time in a specific IANA timezone (e.g. "America/New_York"). Today\'s date is already given to you in the system prompt — you do not need this tool for it. Returns ISO 8601 and a human-readable form.',
			parameters: {
				type: 'object',
				properties: {
					timezone: {
						type: 'string',
						description: 'IANA timezone name. Defaults to UTC if omitted.',
					},
				},
				additionalProperties: false,
			},
		},
	},
	metadata: { displayLabel: 'Clock', icon: 'clock' },
	execute(args, ctx) {
		const tz = parseTimezone(args, ctx.userId);
		const now = new Date();
		try {
			const human = new Intl.DateTimeFormat('en-US', {
				timeZone: tz,
				dateStyle: 'full',
				timeStyle: 'long',
			}).format(now);
			return {
				content: JSON.stringify({
					iso: now.toISOString(),
					human,
					timezone: tz,
				}),
			};
		} catch {
			// Intl.DateTimeFormat throws RangeError on unknown timezones.
			return {
				content: JSON.stringify({
					error: `Unknown IANA timezone: ${tz}. Try a name like "America/New_York" or "UTC".`,
				}),
				isError: true,
			};
		}
	},
};

/**
 * The zone to answer in: whatever the model asked for, else the USER's own zone
 * (browser-reported, on their preferences), else the server's.
 *
 * It used to default to UTC, which quietly made "what time is it?" wrong for
 * almost everybody — the model has no way to know the user's zone unless we tell
 * it, so it wasn't going to pass one, and UTC is nobody's wall clock.
 */
function parseTimezone(args: unknown, userId: string): string {
	if (args && typeof args === 'object' && 'timezone' in args) {
		const tz = (args as { timezone: unknown }).timezone;
		if (typeof tz === 'string' && tz.length > 0) return tz;
	}
	return resolveTimeZone(getUserPreferences(userId)?.timezone ?? null);
}

register(clockTool);
