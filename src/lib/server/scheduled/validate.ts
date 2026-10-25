/**
 * Validate a create/update body for a scheduled task into the stored input.
 * Every field is required on both: the settings editor always sends the whole
 * schedule, so there's no partial-update shape to keep in step.
 */
import { error } from '@sveltejs/kit';
import { MAX_MESSAGE_CHARS, MAX_PROMPT_CHARS } from '../text-limits';
import { getCustomModelForUser } from '../db/queries/custom-models';
import type { ScheduledTaskInput } from '../db/queries/scheduled-tasks';
import { getScheduledTasksConfig } from '../endpoints/config';
import { listAllModels } from '../endpoints/list-models';
import { parseModelId } from '../endpoints/model-id';
import { getEndpoint } from '../endpoints/registry';
import { validateDisabledFeaturesOrThrow400 } from '../util/validate-features';
import { isValidTimeZone, parseCadence } from './cadence';
import { coerceToolPolicy } from './tool-policy';
import { LINE_BREAKS } from '../prompt-snippets/markdown';

export const MAX_SCHEDULE_NAME_LENGTH = 100;
/** A day: a run that can't start within one has no business starting. */
export const MAX_DEADLINE_MINUTES = 24 * 60;
export const MIN_DEADLINE_MINUTES = 5;

function requiredText(raw: unknown, field: string, max: number): string {
	const v = typeof raw === 'string' ? raw.trim() : '';
	if (!v) error(400, `'${field}' is required`);
	if (v.length > max) error(400, `'${field}' must be ${max} characters or fewer`);
	return v;
}

export async function validateScheduledTaskBody(
	body: Record<string, unknown>,
	userId: string,
): Promise<ScheduledTaskInput> {
	const cfg = getScheduledTasksConfig();
	const name = requiredText(body.name, 'name', MAX_SCHEDULE_NAME_LENGTH);
	if (LINE_BREAKS.test(name)) error(400, "'name' must not contain line breaks");
	const prompt = requiredText(body.prompt, 'prompt', MAX_MESSAGE_CHARS);

	// A custom model is copied in at save time, as a conversation copies it at
	// create time: base model, system prompt and parameters.
	let modelId: string;
	let customModelId: string | null = null;
	let systemPrompt: string | null = null;
	let parameters: ScheduledTaskInput['parameters'] = null;
	if (typeof body.customModelId === 'string' && body.customModelId) {
		const cm = getCustomModelForUser(body.customModelId, userId);
		if (!cm) error(400, `Unknown custom model "${body.customModelId}"`);
		modelId = `${cm.baseEndpointId}::${cm.baseModelId}`;
		customModelId = cm.id;
		systemPrompt = cm.systemPrompt;
		parameters = cm.parameters;
	} else {
		modelId = requiredText(body.modelId, 'modelId', 500);
		if (body.systemPrompt !== undefined && body.systemPrompt !== null) {
			if (typeof body.systemPrompt !== 'string') error(400, "'systemPrompt' must be a string");
			const sp = body.systemPrompt.trim();
			if (sp.length > MAX_PROMPT_CHARS) {
				error(400, `'systemPrompt' must be ${MAX_PROMPT_CHARS} characters or fewer`);
			}
			systemPrompt = sp || null;
		}
	}
	const parsed = parseModelId(modelId);
	if (!parsed) error(400, `Malformed model id "${modelId}"`);
	if (!getEndpoint(parsed.endpointId)) {
		error(400, `Unknown endpoint "${parsed.endpointId}" — not in config.toml`);
	}
	// Chat models only: a run is a chat turn. An endpoint that can't list its
	// models right now isn't grounds to refuse the save — the run will say so.
	const entry = (await listAllModels()).find(
		(m) => m.endpointId === parsed.endpointId && m.upstreamId === parsed.upstreamId,
	);
	if (entry && entry.kind !== 'chat') error(400, 'Scheduled tasks run on chat models only');

	const cadence = parseCadence(body.cadence, cfg.minIntervalHours);
	if (!cadence.ok) error(400, cadence.error);
	if (!isValidTimeZone(body.timezone)) error(400, "'timezone' must be an IANA time zone");

	const deadline = body.deadlineMinutes ?? cfg.defaultDeadlineMinutes;
	if (
		typeof deadline !== 'number' ||
		!Number.isInteger(deadline) ||
		deadline < MIN_DEADLINE_MINUTES ||
		deadline > MAX_DEADLINE_MINUTES
	) {
		error(
			400,
			`'deadlineMinutes' must be a whole number from ${MIN_DEADLINE_MINUTES} to ${MAX_DEADLINE_MINUTES}`,
		);
	}
	if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
		error(400, "'enabled' must be a boolean");
	}

	return {
		name,
		prompt,
		modelId,
		customModelId,
		systemPrompt,
		parameters,
		cadence: cadence.cadence,
		timezone: body.timezone,
		toolPolicy: coerceToolPolicy(body.toolPolicy),
		disabledFeatures: validateDisabledFeaturesOrThrow400(body.disabledFeatures),
		deadlineMinutes: deadline,
		enabled: body.enabled ?? true,
	};
}
