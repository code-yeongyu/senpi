/**
 * `senpi schedule list|cancel|run` - the out-of-process half of durable scheduled prompts.
 *
 * The `schedule_prompt` tool only writes job files (`core/extensions/builtin/schedule/`); this
 * command fires them, so a job scheduled by a `--print` run that has long exited still runs.
 * `run` fires what is due once and exits (cron-friendly); `run --watch` stays up (launchd/systemd
 * friendly). Every runner holds a lease with a heartbeat, which lets other runners recover
 * occurrences it abandoned by crashing and lets the tool tell the model whether a runner is live.
 *
 * Delivery: `--exec <command>` runs a shell command with the event as JSON on stdin (integrations
 * such as a chat bridge own the delivery); without it, the scheduling session is resumed headlessly
 * with `senpi -p --session <file|id> <message>` in the session's working directory, deferred while
 * another process has that session open.
 *
 * `run` prints one JSON line per event on stdout so a service log is machine-readable.
 */

import { APP_NAME, getAgentDir } from "../config.ts";
import { cancelScheduledJob } from "../core/extensions/builtin/schedule/occurrences.ts";
import { liveRunners, RUNNER_HEARTBEAT_STALE_MS } from "../core/extensions/builtin/schedule/runner-lease.ts";
import { listScheduledJobs, scheduleDir } from "../core/extensions/builtin/schedule/store.ts";
import { type RunOptions, runPasses, writeLine } from "./schedule-watch.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const DEFAULT_POLL_SECONDS = 60;
const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_CONCURRENCY = 4;

const USAGE = `usage: ${APP_NAME} schedule <list|cancel|run> [options]

  list    [--json]                       every scheduled prompt, all sessions
  cancel  <id>                           cancel a scheduled prompt for good
  run     [--watch] [--exec <command>]   fire due prompts (once, or keep running with --watch)
          [--poll-seconds <n>]           --watch rescan interval (default ${DEFAULT_POLL_SECONDS}; new jobs also wake it)
          [--timeout-seconds <n>]        per-delivery time limit (default ${DEFAULT_TIMEOUT_SECONDS})
          [--concurrency <n>]            sessions delivered in parallel (default ${DEFAULT_CONCURRENCY})

Scheduled prompts are created by the schedule_prompt tool from any session, including --print runs.
With --exec, the command receives the due prompt as one JSON object on stdin (plus SENPI_SCHEDULE_ID,
SENPI_SCHEDULE_SESSION_ID, SENPI_SCHEDULE_SESSION_FILE, SENPI_SCHEDULE_CWD); exit 0 means delivered.
Without --exec, the scheduling session is resumed headlessly: ${APP_NAME} -p --session <session> <prompt>,
waiting while another process has that session open.`;

class UsageError extends Error {}

function positiveInteger(flag: string, value: string | undefined): number {
	const parsed = Number(value);
	if (value === undefined || !Number.isSafeInteger(parsed) || parsed < 1) {
		throw new UsageError(`${flag} needs a positive integer`);
	}
	return parsed;
}

function parseRunOptions(args: readonly string[]): RunOptions {
	let watch = false;
	let exec: string | undefined;
	let pollSeconds = DEFAULT_POLL_SECONDS;
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	let concurrency = DEFAULT_CONCURRENCY;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--watch") watch = true;
		else if (arg === "--exec") {
			exec = args[++index];
			if (exec === undefined || exec.trim().length === 0) throw new UsageError("--exec needs a command");
		} else if (arg === "--poll-seconds") pollSeconds = positiveInteger(arg, args[++index]);
		else if (arg === "--timeout-seconds") timeoutSeconds = positiveInteger(arg, args[++index]);
		else if (arg === "--concurrency") concurrency = positiveInteger(arg, args[++index]);
		else throw new UsageError(`unknown option for run: ${arg}`);
	}
	return { watch, exec, pollSeconds, timeoutSeconds, concurrency };
}

function formatRelative(ms: number): string {
	const minutes = Math.round(Math.abs(ms) / 60_000);
	const text =
		minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
	return ms >= 0 ? `in ${text}` : `${text} ago`;
}

async function list(dir: string, json: boolean): Promise<number> {
	const { jobs, invalid } = await listScheduledJobs(dir);
	const now = Date.now();
	const runners = (await liveRunners(dir)).map((runner) => ({
		...runner,
		fresh: now - runner.beatAt <= RUNNER_HEARTBEAT_STALE_MS,
	}));
	if (json) {
		writeLine({
			jobs: jobs.map((record) => ({
				state: record.state,
				file: record.file,
				...(record.occurrence === undefined ? {} : { occurrence: record.occurrence }),
				...record.job,
			})),
			invalid,
			runners,
		});
		return EXIT_OK;
	}
	const lines = jobs.map(({ state, job, occurrence }) => {
		const every = job.everyMs === null ? "" : ` every ${Math.round(job.everyMs / 1000)}s`;
		const which = occurrence === undefined ? "" : ` #${occurrence}`;
		const error = job.lastError === null ? "" : ` (error: ${job.lastError})`;
		return `${job.id}${which}  ${state}  ${new Date(job.dueAt).toISOString()} (${formatRelative(job.dueAt - now)})${every}  session ${job.sessionId}${error}\n    ${job.prompt.split("\n")[0]}`;
	});
	for (const bad of invalid) lines.push(`${bad.file}  invalid: ${bad.error}`);
	if (lines.length === 0) lines.push("No scheduled prompts.");
	const watchers = runners.filter((runner) => runner.watch && runner.fresh);
	lines.push(
		watchers.length > 0
			? `Runner: active (pid ${watchers.map((runner) => runner.pid).join(", ")})`
			: `Runner: none (start one with \`${APP_NAME} schedule run --watch\`)`,
	);
	process.stdout.write(`${lines.join("\n")}\n`);
	return EXIT_OK;
}

async function cancel(dir: string, id: string | undefined): Promise<number> {
	if (id === undefined) throw new UsageError("cancel needs a job id");
	const removed = await cancelScheduledJob(dir, id);
	if (removed === undefined) {
		process.stderr.write(`No scheduled prompt ${id}.\n`);
		return EXIT_FAILED;
	}
	process.stdout.write(
		removed.inFlight
			? `Cancelled ${id}. One delivery had already started and may still complete; nothing after it will run.\n`
			: `Cancelled ${id}.\n`,
	);
	return EXIT_OK;
}

/** Runs `senpi schedule ...` (argv without the leading `schedule`) and returns the exit code. */
export async function runScheduleCommand(args: readonly string[]): Promise<number> {
	const dir = scheduleDir(getAgentDir());
	const [subcommand, ...rest] = args;
	try {
		switch (subcommand) {
			case "list":
				if (rest.some((arg) => arg !== "--json"))
					throw new UsageError(`unknown option for list: ${rest.join(" ")}`);
				return await list(dir, rest.includes("--json"));
			case "cancel":
				if (rest.length > 1) throw new UsageError("cancel takes exactly one job id");
				return await cancel(dir, rest[0]);
			case "run":
				return await runPasses(dir, parseRunOptions(rest));
			case "--help":
			case "-h":
			case "help":
				process.stdout.write(`${USAGE}\n`);
				return EXIT_OK;
			default:
				throw new UsageError(subcommand === undefined ? "missing subcommand" : `unknown subcommand: ${subcommand}`);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n${USAGE}\n`);
			return EXIT_USAGE;
		}
		throw error;
	}
}
