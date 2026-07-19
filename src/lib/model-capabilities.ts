/**
 * Consumption of the openai-api-bridge `capabilities` field — the per-model
 * `{input}-to-{output}` modality routes on a /v1/models row (spec:
 * openai-api-bridge/docs/model-capabilities.md). The bridge collapses
 * text-to-image / image-to-image sibling endpoints into one id and routes on
 * the attached image, so this array is the only remaining signal for what a
 * given model does with an image.
 *
 * Client-safe ($lib): both the model picker (the modality pill) and the
 * composer (the image-required send gate) read these, so the predicate lives
 * in one place. Nothing here is OpenAI-standard — the field is a bridge
 * extension, absent on generic passthrough upstreams.
 */

export type ImageAttachment = 'required' | 'optional' | 'unsupported' | 'unknown';

/**
 * What a model does with an attached image, derived from its capability routes.
 *
 * Absence of the field is `unknown`, NEVER a denial — an OpenAI-passthrough
 * upstream reports nothing and must stay fully usable, so callers fall back to
 * their own default rather than disabling the model. Match on the
 * `{input}-to-` prefix, not whole strings, so a new output modality from the
 * vocabulary doesn't silently read as `unsupported`.
 */
export function imageAttachment(model: { capabilities?: string[] }): ImageAttachment {
	const caps = model.capabilities;
	if (!caps?.length) return 'unknown';
	const fromImage = caps.some((c) => c.startsWith('image-to-'));
	const fromText = caps.some((c) => c.startsWith('text-to-'));
	if (fromImage && fromText) return 'optional';
	if (fromImage) return 'required';
	return 'unsupported';
}

/**
 * Whether the model accepts an image as input, from any `image-to-*` route.
 * Drives the picker's vision marker on chat models. Absence of the field is
 * `false` here (we only mark what's positively reported) — but callers must not
 * turn that into "rejects images": an unknown chat model stays free to attach.
 */
export function acceptsImageInput(caps: string[] | undefined): boolean {
	return !!caps?.some((c) => c.startsWith('image-to-'));
}

// Single-letter abbreviations + words for the modality vocabulary. Inputs are
// rendered in this fixed order (matching the spec's guaranteed ordering) so a
// combined route reads T-before-I-before-V regardless of array order.
const INPUT_ORDER = ['text', 'image', 'video', 'audio'] as const;
const LETTER: Record<string, string> = {
	text: 'T',
	image: 'I',
	video: 'V',
	audio: 'A',
	embedding: 'E',
};
const WORD: Record<string, string> = {
	text: 'text',
	image: 'image',
	video: 'video',
	audio: 'audio',
	embedding: 'embedding',
};

export interface CapabilityPill {
	/** Compact abbreviation, e.g. "T2I", "I2I", "TI2V". */
	label: string;
	/** Long form for a tooltip/title, e.g. "Text or image → image". */
	title: string;
	/**
	 * Image-attachment requirement this pill represents — the axis the whole
	 * chip is colored by (none / optional / required). Mirrors
	 * {@link imageAttachment} on the same routes.
	 */
	attachment: Exclude<ImageAttachment, 'unknown'>;
}

const letterOf = (modality: string): string =>
	LETTER[modality] ?? modality[0]?.toUpperCase() ?? '?';

/**
 * Build the picker's modality pill from a model's capability routes: one badge
 * whose input side is the UNION of every route's input (so a text+image model
 * is a single `TI2I`, not two pills). Returns null when the field is absent or
 * carries no recognizable `{input}-to-{output}` route.
 */
export function capabilityPill(caps: string[] | undefined): CapabilityPill | null {
	if (!caps?.length) return null;
	const routes = caps
		.map((c) => {
			const i = c.indexOf('-to-');
			return i < 0 ? null : { input: c.slice(0, i), output: c.slice(i + 4) };
		})
		.filter((r): r is { input: string; output: string } => r !== null);
	if (routes.length === 0) return null;

	const inputSet = new Set(routes.map((r) => r.input));
	const orderedInputs: string[] = INPUT_ORDER.filter((m) => inputSet.has(m));
	// Any input the vocabulary above doesn't know about still gets a letter, so
	// a future modality shows up rather than vanishing from the union.
	for (const r of routes)
		if (!(INPUT_ORDER as readonly string[]).includes(r.input)) orderedInputs.push(r.input);
	const outputs = [...new Set(routes.map((r) => r.output))];

	const inAbbr = orderedInputs.map(letterOf).join('');
	const outAbbr = outputs.map(letterOf).join('/');
	const label = `${inAbbr}2${outAbbr}`;

	const inWords = orderedInputs.map((m) => WORD[m] ?? m);
	const inPhrase =
		inWords.length > 1
			? `${inWords.slice(0, -1).join(', ')} or ${inWords[inWords.length - 1]}`
			: inWords[0];
	const outPhrase = outputs.map((m) => WORD[m] ?? m).join(' / ');
	const title = `${inPhrase.charAt(0).toUpperCase()}${inPhrase.slice(1)} → ${outPhrase}`;

	const hasImage = inputSet.has('image');
	const hasText = inputSet.has('text');
	const attachment = hasImage && hasText ? 'optional' : hasImage ? 'required' : 'unsupported';
	return { label, title, attachment };
}
