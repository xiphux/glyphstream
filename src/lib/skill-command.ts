/**
 * Slash-command parsing for explicit skill activation. Pure + framework-free so
 * it can be unit-tested in isolation and shared by both composers (chat page +
 * new-chat home). The composer detects a leading `/<token>` and offers an
 * autocomplete of enabled skills; on send, a leading token that matches an
 * enabled skill is stripped from the message and turned into an activation.
 *
 * MVP scope: ONE leading command at the very start of the composer. A `/token`
 * containing a second slash (e.g. `/etc/passwd`) is never treated as a command,
 * and a token that doesn't match an enabled skill is left untouched — both
 * disambiguate file paths and stray slashes from real activations.
 */

/** Minimal skill shape the parser needs (the client ships {id,name,description}). */
export interface SkillCommandOption {
	name: string;
}

/** The leading `/token` of the composer plus any message text after it, or null
 *  when the text doesn't start with a single `/token`. */
export interface LeadingSkillToken {
	token: string;
	/** Message text after the token (trimmed of the single separating run of
	 *  whitespace). Empty when the user typed only `/token`. */
	rest: string;
}

const LEADING_TOKEN = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;
const IN_PROGRESS_QUERY = /^\/([^\s/]*)$/;

/** Parse a leading `/token message…`. Returns null when the text isn't a
 *  leading slash command (no leading `/`, a space right after `/`, or a second
 *  slash in the token). */
export function parseLeadingSkillToken(text: string): LeadingSkillToken | null {
	const m = LEADING_TOKEN.exec(text);
	if (!m) return null;
	return { token: m[1], rest: m[2] ?? '' };
}

/** The in-progress autocomplete query: the prefix after `/` while the user is
 *  still typing the skill name (no space yet, no second slash). Returns null
 *  when the menu should be closed (text doesn't match, or a space/second slash
 *  has been typed — the command is "locked in" and the user is now typing the
 *  message). `''` (bare `/`) means "show all skills". */
export function skillMenuQuery(text: string): string | null {
	const m = IN_PROGRESS_QUERY.exec(text);
	return m ? m[1] : null;
}

/** Filter + order enabled skills for the autocomplete: case-insensitive name
 *  prefix match on the query, original order preserved. */
export function filterSkillCommands<T extends SkillCommandOption>(skills: T[], query: string): T[] {
	const q = query.toLowerCase();
	if (q === '') return skills;
	return skills.filter((s) => s.name.toLowerCase().startsWith(q));
}

export interface StrippedSkillCommand {
	/** The message text with the leading skill command removed (trimmed). */
	text: string;
	/** The activated skill name(s) — at most one for MVP, [] when no command. */
	activatedSkillNames: string[];
}

/**
 * If `text` begins with `/<name>` and `<name>` exactly matches an enabled
 * skill, strip the command from the message and return the activation;
 * otherwise return the text unchanged with no activation. Exact
 * (case-sensitive) match against the stored slug — the autocomplete inserts the
 * canonical name, and a hand-typed name must match the slug exactly.
 *
 * When the command stands alone (no message after it), the original text is
 * kept as the message so the turn isn't empty — a bare `/review` is itself a
 * valid, sendable request ("run the review skill"), and the activation still
 * fires. Only a message that FOLLOWS the command is stripped, so
 * `/review check this` sends the clean "check this".
 */
export function stripSkillCommand(
	text: string,
	enabledSkills: SkillCommandOption[],
): StrippedSkillCommand {
	const parsed = parseLeadingSkillToken(text);
	if (!parsed) return { text, activatedSkillNames: [] };
	const match = enabledSkills.find((s) => s.name === parsed.token);
	if (!match) return { text, activatedSkillNames: [] };
	const rest = parsed.rest.trim();
	return { text: rest.length > 0 ? rest : text, activatedSkillNames: [match.name] };
}
