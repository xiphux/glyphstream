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

export const clockTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'get_current_time',
			description:
				'Get the current date and time. Optionally accepts an IANA timezone name (e.g. "America/New_York", "Europe/London", "Asia/Tokyo"). Returns ISO 8601 and a human-readable form.',
			parameters: {
				type: 'object',
				properties: {
					timezone: {
						type: 'string',
						description: 'IANA timezone name. Defaults to UTC if omitted.'
					}
				},
				additionalProperties: false
			}
		}
	},
	metadata: { displayLabel: 'Clock', icon: 'clock' },
	execute(args) {
		const tz = parseTimezone(args);
		const now = new Date();
		try {
			const human = new Intl.DateTimeFormat('en-US', {
				timeZone: tz,
				dateStyle: 'full',
				timeStyle: 'long'
			}).format(now);
			return {
				content: JSON.stringify({
					iso: now.toISOString(),
					human,
					timezone: tz
				})
			};
		} catch {
			// Intl.DateTimeFormat throws RangeError on unknown timezones.
			return {
				content: JSON.stringify({
					error: `Unknown IANA timezone: ${tz}. Try a name like "America/New_York" or "UTC".`
				}),
				isError: true
			};
		}
	}
};

function parseTimezone(args: unknown): string {
	if (args && typeof args === 'object' && 'timezone' in args) {
		const tz = (args as { timezone: unknown }).timezone;
		if (typeof tz === 'string' && tz.length > 0) return tz;
	}
	return 'UTC';
}

register(clockTool);
