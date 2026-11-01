import { handleItemEvent } from "./item-events";
import { isBankJob, RetryLater, retryDelaySeconds, type BankJob } from "./jobs";
import { completeLink } from "./link";
import { STALE_RUN_MS, startSync, syncPage } from "./sync";

/** Queue consumer for BANK_JOBS (max_batch_size 1, so one job per invocation). */
export async function handleBankJobs(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		if (!isBankJob(message.body)) {
			console.error("Dropped an unrecognised bank job.");
			message.ack();
			continue;
		}
		try {
			await runJob(env, message.body);
			message.ack();
		} catch (error) {
			const delaySeconds = retryDelaySeconds(message.attempts);
			if (error instanceof RetryLater) {
				console.warn(`${error.message} Retrying in ${delaySeconds}s.`);
			} else {
				const name = error instanceof Error ? error.name : "UnknownError";
				console.error(`Bank job ${message.body.kind} failed (${name}). Retrying in ${delaySeconds}s.`);
			}
			message.retry({ delaySeconds });
		}
	}
}

export function runJob(env: Env, job: BankJob): Promise<void> {
	switch (job.kind) {
		case "complete_link":
			return completeLink(env, job.linkTokenHash);
		case "sync_start":
			return startSync(env, job.itemId);
		case "sync_page":
			return syncPage(env, job.itemId, job.runId, job.step);
		case "item_event":
			return handleItemEvent(env, job.itemId, job.code, job.errorCode);
	}
}

/** Daily catch-up sync, 06:30 New York in winter (crons are UTC). */
export const DAILY_SYNC_CRON = "30 11 * * *";
/** Hourly: finish Link sessions whose webhook was missed, revive dead sync runs. */
export const HOURLY_CRON = "0 * * * *";

/**
 * Crons only enqueue (cheap), as a fallback for missed webhooks (WEBHOOK-007);
 * Plaid's SYNC_UPDATES_AVAILABLE stays the primary trigger.
 */
export async function handleBankCron(cron: string, env: Env, now = new Date()): Promise<void> {
	const jobs: BankJob[] = [];

	const pending = await env.DB.prepare("SELECT link_token_hash FROM bank_link_sessions WHERE status = 'pending'")
		.all<{ link_token_hash: string }>();
	for (const row of pending.results) jobs.push({ kind: "complete_link", linkTokenHash: row.link_token_hash });

	const staleBefore = new Date(now.getTime() - STALE_RUN_MS).toISOString();
	const syncable = await env.DB.prepare(
		`SELECT item_id, sync_run_id, sync_started_at FROM bank_items WHERE status IN ('ok', 'pending_disconnect')`,
	).all<{ item_id: string; sync_run_id: string | null; sync_started_at: string | null }>();
	for (const item of syncable.results) {
		const dead = item.sync_run_id !== null && (item.sync_started_at ?? "") < staleBefore;
		if (cron === DAILY_SYNC_CRON || dead) jobs.push({ kind: "sync_start", itemId: item.item_id });
	}

	// Housekeeping: finished Link sessions are useless after a week.
	const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
	await env.DB.prepare("DELETE FROM bank_link_sessions WHERE status != 'pending' AND created_at < ?")
		.bind(weekAgo)
		.run();

	for (let i = 0; i < jobs.length; i += 100) {
		await env.BANK_JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
	}
	if (jobs.length > 0) console.log(`Bank cron queued ${jobs.length} job(s).`);
}
