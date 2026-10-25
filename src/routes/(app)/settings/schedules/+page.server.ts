import { error } from '@sveltejs/kit';
import { listCustomModelsForUser } from '#lib/server/db/queries/custom-models.js';
import { latestScheduledRuns, listScheduledTasks } from '#lib/server/db/queries/scheduled-tasks.js';
import { getScheduledTasksConfig } from '#lib/server/endpoints/config.js';
import { listAllModels } from '#lib/server/endpoints/list-models.js';
import { awaitMcpReady } from '#lib/server/mcp/bootstrap.js';
import { getUserServerStates } from '#lib/server/mcp/registry.js';
import { buildRegisteredName } from '#lib/server/mcp/tool-bridge.js';
import type { PageServerLoad } from './$types';

/** Bounded like /settings/mcp's, but shorter: here the server list is only
 *  what the tool picker offers, and a server still connecting shows its last
 *  known tools. */
const SCHEDULES_MCP_CONNECT_BUDGET_MS = 5_000;

export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	const { prefs } = await parent();
	if (!locals.user) error(401, 'Authentication required');
	const cfg = getScheduledTasksConfig();
	if (!cfg.enabled) error(404, 'Scheduled tasks are turned off on this server');
	// Tagged so a save / delete / Run now can refresh just this page.
	depends('settings:schedules');
	const userId = locals.user.id;

	const schedules = listScheduledTasks(userId);
	const latest = latestScheduledRuns(
		schedules.map((s) => s.id),
		userId,
	);

	await awaitMcpReady();
	const [models, states] = await Promise.all([
		listAllModels(),
		getUserServerStates(userId, {
			connectBudgetMs: SCHEDULES_MCP_CONNECT_BUDGET_MS,
			backgroundKnownServers: true,
		}),
	]);

	return {
		schedules: schedules.map((s) => ({ ...s, lastRun: latest.get(s.id) ?? null })),
		// Runs are chat turns, so only chat models are offered.
		models: models
			.filter((m) => m.kind === 'chat')
			.map((m) => ({ id: m.id, name: m.displayName }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		customModels: listCustomModelsForUser(userId).map((cm) => ({ id: cm.id, name: cm.name })),
		servers: states.map((s) => ({
			id: s.id,
			displayName: s.displayName,
			state: s.state,
			tools: s.tools.map((t) => ({
				name: t.name,
				registeredName: buildRegisteredName(s.id, t.name),
				description: t.description ?? '',
			})),
		})),
		// The browser reports the user's zone; until it has, the editor fills its own.
		defaultTimezone: prefs?.timezone ?? null,
		defaultDeadlineMinutes: cfg.defaultDeadlineMinutes,
		minIntervalHours: cfg.minIntervalHours,
	};
};
