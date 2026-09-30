/**
 * Durable media generation jobs — see `generationJobs` in the schema and
 * `server/generation/jobs.ts`, the runner that owns every write here.
 *
 * Operator-facing lifecycle, not a user-facing surface: nothing here is read on
 * behalf of a request, so nothing is scoped by user id. Each row carries its
 * `user_id` anyway (it is user-owned data, and the FK cascade on user delete
 * needs it); the runner acts as that user when it resumes the row.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { getDb, type Tx } from '../client';
import { generationJobs } from '../schema';

export type GenerationJobRow = typeof generationJobs.$inferSelect;
export type NewGenerationJob = Omit<
	typeof generationJobs.$inferInsert,
	'state' | 'attempts' | 'preparedJson' | 'upstreamJobId' | 'startedAt'
>;

export function insertGenerationJob(job: NewGenerationJob): void {
	getDb().insert(generationJobs).values(job).run();
}

/**
 * Every job left over from a previous process, in submission order (the order
 * the runner re-registers them in).
 *
 * Ordered by `created_at` with `rowid` as the tiebreak: a fan-out's branches can
 * land in the same millisecond, and without a tiebreak their resumed order would
 * be whatever the planner returns — the queue would come back reshuffled.
 * `rowid` is monotonic for a table like this one (no explicit rowids, rows only
 * appended), so it is insertion order.
 */
export function listGenerationJobs(): GenerationJobRow[] {
	return getDb()
		.select()
		.from(generationJobs)
		.orderBy(asc(generationJobs.createdAt), asc(sql`rowid`))
		.all();
}

/**
 * Record that the job was granted its endpoint slot. Returns false when the row
 * is gone — the anchor's branch or the conversation was deleted while the job
 * waited in line — which tells the runner to abandon the work rather than spend
 * a generation on a result with nowhere to land.
 */
export function markGenerationJobRunning(id: string, at: number): boolean {
	const r = getDb()
		.update(generationJobs)
		.set({ state: 'running', startedAt: at })
		.where(eq(generationJobs.id, id))
		.run();
	return Number(r.changes) > 0;
}

export function setGenerationJobPrepared(id: string, preparedJson: string): void {
	getDb().update(generationJobs).set({ preparedJson }).where(eq(generationJobs.id, id)).run();
}

export function setGenerationJobUpstreamId(id: string, upstreamJobId: string): void {
	getDb().update(generationJobs).set({ upstreamJobId }).where(eq(generationJobs.id, id)).run();
}

/**
 * Put an interrupted job back in line, counting the interruption. Its upstream
 * job id is cleared with it: the resumed run starts a fresh upstream job.
 */
export function requeueGenerationJob(id: string, attempts: number): void {
	getDb()
		.update(generationJobs)
		.set({ state: 'queued', attempts, startedAt: null, upstreamJobId: null })
		.where(eq(generationJobs.id, id))
		.run();
}

/**
 * Count an interruption against a job that is still running — a reattached
 * video whose bridge job was lost, now starting over with a new one. Its old
 * upstream id is cleared with it; the new one is recorded when created.
 */
export function recordGenerationJobInterruption(id: string, attempts: number): void {
	getDb()
		.update(generationJobs)
		.set({ attempts, upstreamJobId: null })
		.where(eq(generationJobs.id, id))
		.run();
}

/**
 * Delete the job as part of the transaction that persists its outcome.
 *
 * The row's deletion IS the commit token: returning false means the row was
 * already gone (its anchor or conversation deleted, or the job cancelled), and
 * the caller must roll the append back rather than land a result under a
 * vanished anchor — or land it twice, if a resumed copy already has.
 */
export function consumeGenerationJob(tx: Tx, id: string): boolean {
	return Number(tx.delete(generationJobs).where(eq(generationJobs.id, id)).run().changes) > 0;
}

/** Idempotent cleanup for every exit that doesn't persist an outcome. */
export function deleteGenerationJob(id: string): void {
	getDb().delete(generationJobs).where(eq(generationJobs.id, id)).run();
}

/** Test/diagnostic: is this job still queued or running? */
export function generationJobExists(id: string): boolean {
	return (
		getDb()
			.select({ id: generationJobs.id })
			.from(generationJobs)
			.where(eq(generationJobs.id, id))
			.get() !== undefined
	);
}
