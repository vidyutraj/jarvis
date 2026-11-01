/**
 * Bank work runs on a Queue (binding BANK_JOBS), one small job per invocation,
 * so each invocation stays inside the Workers free plan's CPU budget and gets
 * automatic retries. Webhooks and crons only enqueue.
 */

export type BankJob =
	/** A Hosted Link session may have finished: fetch its results and add or repair Items. */
	| { kind: "complete_link"; linkTokenHash: string }
	/** Start (or queue another) sync run for an Item. */
	| { kind: "sync_start"; itemId: string }
	/** Fetch one /transactions/sync page of a run. Runs only if run id and step still match. */
	| { kind: "sync_page"; itemId: string; runId: string; step: number }
	/** An ITEM webhook (login required, disconnect warnings, repaired, revoked). */
	| { kind: "item_event"; itemId: string; code: string; errorCode?: string };

/** Thrown by a job to ask the Queue to retry later (transient Plaid or network failures). */
export class RetryLater extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetryLater";
	}
}

/** Capped exponential backoff with jitter (ITEM-004, ITEM-013). */
export function retryDelaySeconds(attempts: number): number {
	const base = Math.min(30 * 2 ** Math.max(0, attempts - 1), 1800);
	return Math.round(base / 2 + Math.random() * (base / 2));
}

export function isBankJob(value: unknown): value is BankJob {
	if (typeof value !== "object" || value === null) return false;
	const job = value as Record<string, unknown>;
	switch (job.kind) {
		case "complete_link":
			return typeof job.linkTokenHash === "string";
		case "sync_start":
			return typeof job.itemId === "string";
		case "sync_page":
			return typeof job.itemId === "string" && typeof job.runId === "string" && typeof job.step === "number";
		case "item_event":
			return typeof job.itemId === "string" && typeof job.code === "string";
		default:
			return false;
	}
}

export function enqueue(env: Pick<Env, "BANK_JOBS">, job: BankJob): Promise<unknown> {
	return env.BANK_JOBS.send(job);
}
