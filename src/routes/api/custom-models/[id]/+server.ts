import { error, json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	deleteCustomModel,
	getCustomModelForUser,
	updateCustomModel,
} from '$lib/server/db/queries/custom-models';
import {
	validateDefaultDisabledFeatures,
	validateParameters,
} from '$lib/server/custom-models/validate';
import { getEndpoint } from '$lib/server/endpoints/registry';
import type { UpdateCustomModelRequest } from '$lib/types/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const m = requireFound(
		getCustomModelForUser(params.id, locals.user.id),
		'Custom model not found',
	);
	return json({ customModel: m });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<UpdateCustomModelRequest>(request);

	// Patch validation: only check fields actually present. Empty string
	// fields are normalized to null (description, systemPrompt) so the user
	// can clear an optional value via PATCH.
	const patch: Parameters<typeof updateCustomModel>[2] = {};
	if (body.name !== undefined) {
		const name = body.name.trim();
		if (!name) throw error(400, "'name' must not be empty");
		if (name.length > 200) throw error(400, "'name' must be 200 characters or fewer");
		patch.name = name;
	}
	if (body.description !== undefined) {
		patch.description = body.description.trim() || null;
	}
	if (body.baseEndpointId !== undefined) {
		const id = body.baseEndpointId.trim();
		if (!id) throw error(400, "'baseEndpointId' must not be empty");
		if (!getEndpoint(id)) {
			throw error(400, `Unknown endpoint "${id}" — not in config.toml`);
		}
		patch.baseEndpointId = id;
	}
	if (body.baseModelId !== undefined) {
		const id = body.baseModelId.trim();
		if (!id) throw error(400, "'baseModelId' must not be empty");
		patch.baseModelId = id;
	}
	if (body.systemPrompt !== undefined) {
		patch.systemPrompt = body.systemPrompt.trim() || null;
	}
	if (body.parameters !== undefined) {
		patch.parameters = validateParameters(body.parameters);
	}
	if (body.defaultDisabledFeatures !== undefined) {
		patch.defaultDisabledFeatures = validateDefaultDisabledFeatures(body.defaultDisabledFeatures);
	}

	const updated = updateCustomModel(params.id, locals.user.id, patch);
	if (!updated) throw error(404, 'Custom model not found');
	return json({ customModel: updated });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const ok = deleteCustomModel(params.id, locals.user.id);
	if (!ok) throw error(404, 'Custom model not found');
	return new Response(null, { status: 204 });
};
