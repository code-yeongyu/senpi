#!/usr/bin/env node
/**
 * Hosted fallback for release jobs sent to Boat self-hosted runners (senpi#6850).
 *
 * A release dispatch that names `boat_run_label` sends its Boat jobs to ephemeral self-hosted runners that an external
 * dispatcher started in Boat sandboxes. If no runner picks one of those jobs within the queue limit, this dispatches the
 * same workflow again with the same inputs and an empty `boat_run_label` (so every job runs on GitHub-hosted runners),
 * and then cancels this run. It stops watching once the job named DONE_JOB has started.
 *
 *   node scripts/boat-watchdog.mjs
 *
 * Env: GH_REPO, RUN_ID, RUN_ATTEMPT, BOAT_RUN_LABEL, DONE_JOB, WORKFLOW_FILE, DISPATCH_REF, DISPATCH_INPUTS (the run's
 * `toJSON(inputs)`), PIN_SHA (optional: replaces an empty `sha` input so the re-dispatch releases the same commit),
 * QUEUE_LIMIT_SECONDS (default 600), POLL_SECONDS (default 30), GH_BIN (default gh).
 */
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const WAITING = new Set(["queued", "waiting", "pending", "requested"]);

/**
 * What the watchdog does after one look at the run's jobs (`{name, status, labels, created_at}`):
 * `fallback` when a job sent to the Boat label has waited longer than the limit, `done` once DONE_JOB has started
 * (a GitHub-hosted DONE_JOB counts once it exists, since it only exists after every Boat job before it finished),
 * otherwise `wait`.
 */
export function watchdogDecision(jobs, { label, doneJob, limitSeconds, now }) {
	const boatJobs = jobs.filter((job) => (job.labels ?? []).includes(label));
	const stuck = boatJobs.filter((job) => WAITING.has(job.status) && now - Date.parse(job.created_at) >= limitSeconds * 1000);
	if (stuck.length > 0) return { action: "fallback", stuck: stuck.map((job) => job.name) };
	const done = jobs.find((job) => job.name === doneJob);
	if (done && !(boatJobs.includes(done) && WAITING.has(done.status))) return { action: "done" };
	return { action: "wait" };
}

/** The `gh workflow run` arguments that repeat the run on GitHub-hosted runners. */
export function redispatchArgs({ workflowFile, ref, inputs, pinSha }) {
	const fields = { ...inputs, boat_run_label: "" };
	if ("sha" in fields && !fields.sha && pinSha) fields.sha = pinSha;
	const args = ["workflow", "run", workflowFile, "--ref", ref];
	for (const [name, value] of Object.entries(fields)) args.push("-f", `${name}=${value ?? ""}`);
	return args;
}

function gh(bin, args) {
	const result = spawnSync(bin, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

async function main() {
	const env = process.env;
	for (const name of ["GH_REPO", "RUN_ID", "BOAT_RUN_LABEL", "DONE_JOB", "WORKFLOW_FILE", "DISPATCH_REF", "DISPATCH_INPUTS"]) {
		if (!env[name]) throw new Error(`${name} is required`);
	}
	const bin = env.GH_BIN || "gh";
	const limitSeconds = Number(env.QUEUE_LIMIT_SECONDS || 600);
	const pollSeconds = Number(env.POLL_SECONDS || 30);
	const jobsPath = `repos/${env.GH_REPO}/actions/runs/${env.RUN_ID}/attempts/${env.RUN_ATTEMPT || 1}/jobs`;
	for (;;) {
		let jobs;
		try {
			jobs = JSON.parse(gh(bin, ["api", "--paginate", "--slurp", jobsPath])).flatMap((page) => page.jobs);
		} catch (error) {
			// A transient API error is not a verdict on the runners; look again on the next poll.
			process.stdout.write(`::warning::could not list the jobs of run ${env.RUN_ID}: ${error.message}\n`);
			await sleep(pollSeconds * 1000);
			continue;
		}
		const decision = watchdogDecision(jobs, { label: env.BOAT_RUN_LABEL, doneJob: env.DONE_JOB, limitSeconds, now: Date.now() });
		if (decision.action === "done") {
			process.stdout.write(`Every Boat job of run ${env.RUN_ID} was picked up; ${env.DONE_JOB} has started.\n`);
			return 0;
		}
		if (decision.action === "fallback") {
			const args = redispatchArgs({ workflowFile: env.WORKFLOW_FILE, ref: env.DISPATCH_REF, inputs: JSON.parse(env.DISPATCH_INPUTS), pinSha: env.PIN_SHA });
			process.stdout.write(`::error::no Boat runner picked ${decision.stuck.join(", ")} within ${limitSeconds} s; re-dispatching ${env.WORKFLOW_FILE} on GitHub-hosted runners and cancelling run ${env.RUN_ID}\n`);
			// Dispatch first: the new run waits in the workflow's concurrency group until this run is cancelled.
			gh(bin, args);
			gh(bin, ["run", "cancel", env.RUN_ID, "--repo", env.GH_REPO]);
			return 1;
		}
		await sleep(pollSeconds * 1000);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
