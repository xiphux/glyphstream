import { error, json } from '@sveltejs/kit';
import {
	deleteCustomModel,
	getCustomModelForUser,
	updateCustomModel
} from '$lib/server/db/queries/custom-models';
import { validateParameters } from '$lib/server/custom-models/validate';
import { getEndpoint } from '$lib/server/endpoints/registry';
import type { UpdateCustomModelRequest } from '$lib/types/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const m = getCustomModelForUser(params.id, locals.user.id);
	if (!m) throw error(404, 'Custom model not found');
	return json({ customModel: m });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	let body: UpdateCustomModelRequest;
	try {
		body = (await request.json()) as UpdateCustomModelRequest;
	} catch {
		throw error(400, 'Request body must be JSON');
	}

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

	const updated = updateCustomModel(params.id, locals.user.id, patch);
	if (!updated) throw error(404, 'Custom model not found');
	return json({ customModel: updated });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const ok = deleteCustomModel(params.id, locals.user.id);
	if (!ok) throw error(404, 'Custom model not found');
	return new Response(null, { status: 204 });
};
