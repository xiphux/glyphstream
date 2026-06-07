/**
 * Friendly greeting helpers for the new-chat page header.
 *
 * Each greeting is a template string. The user's name is a `{name}` token the
 * line places wherever it reads best — at the end ("Welcome back, {name}"),
 * mid-sentence ("Well, well, well, if it isn't {name}"), or not at all
 * ("Ask me anything"). composeGreeting() fills the token in; templates with
 * no token simply render as-is. This lets lines carry their own punctuation
 * (questions, etc.) instead of being forced into a "{greeting}, {name}" mold.
 *
 * Most greetings are time-neutral: the daytime slots blend a few
 * time-specific lines with a much larger ANYTIME pool, so you get real
 * variety instead of "Good morning" every single morning. The wee-hours and
 * late-night slots keep their own character. Holidays win outright, and a
 * rare per-visit chance sprinkles in easter eggs for anyone paying attention.
 *
 * pickGreeting() rolls a fresh random line each call, so reloading or
 * navigating back to the page gives you something new. greetingContextKey()
 * lets a refocus tell whether the current line is still valid (same
 * holiday / day + time-of-day slot) and re-roll only when it's gone stale,
 * so switching away and back doesn't churn.
 */

// Time-specific flavor, shown only during their slot and blended with ANYTIME.
export const MORNING = ['Good morning, {name}', 'Top of the morning, {name}', 'Morning, {name}'];
export const AFTERNOON = [
	'Good afternoon, {name}',
	'Afternoon, {name}',
	"Hope your day's going well, {name}",
];
export const EVENING = [
	'Good evening, {name}',
	'Evening, {name}',
	'Hope your day went well, {name}',
];

// The wee hours (before 5am) and late night (10pm+) keep their iconic lines —
// "Still up" / "Burning the midnight oil" lead each pool — with a couple
// kindred siblings so even night owls get a bit of rotation. No generic
// easter eggs intrude here; the punchlines carry these slots.
export const EARLY = ['Still up, {name}?', "Can't sleep, {name}?", 'Burning the midnight oil'];
export const NIGHT = [
	'Burning the midnight oil, {name}',
	'Up late again, {name}?',
	'Winding down, {name}?',
];

// Time-neutral greetings — the bulk of the new variety. Eligible all day,
// blended into every daytime slot. Tones run from plain to casual to a touch
// funny, some address the user and some don't; all stay warm and welcoming.
export const ANYTIME = [
	'Welcome back, {name}',
	'Good to see you, {name}',
	'Hey there, {name}',
	'Hello again, {name}',
	'Howdy, {name}',
	"What's on your mind, {name}?",
	'Where should we start, {name}?',
	'Ready when you are, {name}',
	'Long time no see, {name}',
	'Fancy seeing you here, {name}',
	"Look who's back",
	"Let's pick up where we left off",
	'Ask me anything',
];

// Rare easter eggs — a wink for anyone who notices. Surfaced on a small
// per-visit chance (EGG_CHANCE, below) so they stay a treat rather than the
// norm. A few are gentle nerdy nods; none are off-putting.
export const EASTER_EGGS = [
	'Beep boop, {name}',
	'Reading you loud and clear, {name}',
	'May the focus be with you, {name}',
	'Follow the white rabbit, {name}',
	'Salutations, {name}',
	"Well, well, well, if it isn't {name}",
	'Back by popular demand, {name}',
	'There you are, {name}',
];

// Probability that a daytime visit surfaces an easter egg instead of an
// ordinary line. Tune here — ~1 in 16 page opens keeps them a surprise.
const EGG_CHANCE = 0.06;

/** Stable per-day stamp: same number for any Date in the same calendar day.
 * Used only to make the context key (below) day-aware, so a greeting from a
 * previous day counts as stale even within the same time-of-day slot. */
function dayStamp(now: Date): number {
	return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

/**
 * Date-keyed easter eggs. These win over everything else — the whole point of
 * a holiday line is that it shows up on the holiday. Kept deliberately
 * playful and culturally neutral (no religious assumptions) so the header
 * stays welcoming to everyone.
 */
export function holidayGreeting(now: Date): string | null {
	const y = now.getFullYear();
	const m = now.getMonth(); // 0-based
	const d = now.getDate();
	const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

	// Calendar holidays — kept culturally neutral and playful.
	if (m === 0 && d === 1) return 'Happy New Year, {name}';
	if (m === 1 && d === 29) return 'Happy Leap Day, {name}';
	if (m === 3 && d === 1) return 'No tricks, {name}, promise'; // April Fools'
	if (m === 8 && d === 19) return 'Ahoy, {name}'; // Talk Like a Pirate Day
	if (m === 9 && d === 31) return 'Happy Halloween, {name}';

	// Nerd holidays — the audience runs local LLMs; they'll get these.
	if (m === 2 && d === 14) return 'Happy Pi Day, {name}'; // 3.14
	if (m === 2 && d === 31) return 'Backed up lately, {name}?'; // World Backup Day
	if (m === 4 && d === 4) return 'May the 4th be with you, {name}'; // Star Wars Day
	if (m === 4 && d === 25) return "Don't panic, {name}"; // Towel Day / Geek Pride Day
	if (m === 8 && d === (leap ? 12 : 13)) return "Happy Programmers' Day, {name}"; // 256th day
	if (m === 10 && d === 23) return 'Happy Fibonacci Day, {name}'; // 1, 1, 2, 3 → 11/23

	// Floating: any Friday the 13th. Checked last so a dated holiday wins.
	if (d === 13 && now.getDay() === 5) return 'Watch your step, {name}';
	return null;
}

/**
 * Fill a greeting template's `{name}` token with the user's name. Templates
 * that don't reference `{name}` are returned unchanged — that's how a line
 * opts out of addressing the user by name.
 */
export function composeGreeting(template: string, name: string): string {
	return template.replaceAll('{name}', name);
}

/** A chosen greeting plus the context it was chosen for. `key` identifies the
 * holiday / day+slot the line belongs to; when greetingContextKey() later
 * returns something different, this greeting has gone stale. */
export interface GreetingPick {
	greeting: string;
	key: string;
}

/** Name of the time-of-day slot for the given hour. */
function slotFor(hour: number): string {
	if (hour < 5) return 'early';
	if (hour < 12) return 'morning';
	if (hour < 17) return 'afternoon';
	if (hour < 22) return 'evening';
	return 'night';
}

/**
 * Opaque key for the greeting context at `now`: the holiday if there is one,
 * otherwise the calendar day + time-of-day slot. Two moments sharing a key can
 * reuse the same greeting; when the key changes, the old line is stale. This
 * is what lets a refocus leave a still-valid greeting alone while replacing
 * one that's crossed into a new slot, day, or holiday.
 */
export function greetingContextKey(now: Date): string {
	const holiday = holidayGreeting(now);
	if (holiday) return `holiday:${holiday}`;
	return `${dayStamp(now)}:${slotFor(now.getHours())}`;
}

function pickFrom(pool: string[], rand: () => number): string {
	return pool[Math.floor(rand() * pool.length)];
}

/**
 * Roll a greeting for `now`. Unlike a per-day deterministic pick, this draws a
 * fresh random line each call, so revisiting or reloading the new-chat page
 * gives you something new. `rand` is injectable for tests; it defaults to
 * Math.random.
 *
 * The returned `key` should be stashed and compared against
 * greetingContextKey() on refocus — re-roll only when it differs, so switching
 * away and back doesn't churn a greeting that's still valid.
 */
export function pickGreeting(now: Date, rand: () => number = Math.random): GreetingPick {
	const key = greetingContextKey(now);

	// Holidays trump everything and have a single fixed line — no roll.
	const holiday = holidayGreeting(now);
	if (holiday) return { greeting: holiday, key };

	const h = now.getHours();

	// Night slots keep their own character — no easter eggs, just their pool.
	if (h < 5) return { greeting: pickFrom(EARLY, rand), key };
	if (h >= 22) return { greeting: pickFrom(NIGHT, rand), key };

	// Daytime: a small chance of an easter egg, otherwise the current time
	// slot blended with the anytime pool.
	if (rand() < EGG_CHANCE) return { greeting: pickFrom(EASTER_EGGS, rand), key };

	const slot = h < 12 ? MORNING : h < 17 ? AFTERNOON : EVENING;
	return { greeting: pickFrom(slot.concat(ANYTIME), rand), key };
}

/**
 * Best-effort first name. GitHub's `name` field is usually "First Last"
 * but isn't guaranteed (some users only set a single name, some leave it
 * blank). On blank we fall back to the GitHub login so we always have
 * *something* to greet with.
 */
export function firstName(displayName: string | null, fallback: string): string {
	if (!displayName) return fallback;
	const [first] = displayName.trim().split(/\s+/);
	return first || fallback;
}

/**
 * Preferred first name with the user's explicit Preferences > Name field
 * winning over any GitHub-derived name. The Preferences name is exactly
 * "how I want to be referred to," so it's the right input for greeting
 * lines and the user label on message bubbles. Falls through to the
 * GitHub-name extraction when the preference is empty or whitespace-only.
 *
 * Use this in any user-facing surface that addresses the user by name.
 */
export function preferredFirstName(
	preferenceName: string | null | undefined,
	displayName: string | null,
	fallback: string,
): string {
	const fromPref = preferenceName?.trim();
	if (fromPref) return fromPref;
	return firstName(displayName, fallback);
}
