/**
 * KILL-CHILD cases (senpi#5227, plan 3.5): kill the tool child in the middle of a module job and assert today's
 * outcome on the fused placement. A strict job fails `tool_child_exited` and never runs again, an idempotent job runs
 * once more on a fresh child, and the next call after a kill runs on the next generation.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { ToolDispatcher } from "../tool-dispatcher.ts";

/** The module the cases run on the child. `dieOnce` kills its own child the first time it runs (per marker file). */
export const KILL_CHILD_MODULE = `import { appendFileSync, existsSync } from "node:fs";
export function dieOnce(args) {
	appendFileSync(args.log, "run\\n");
	if (!existsSync(args.marker)) {
		appendFileSync(args.marker, "");
		process.kill(process.pid, "SIGKILL");
	}
	return { pid: process.pid };
}
export function survive(args) {
	appendFileSync(args.log, "run\\n");
	return { pid: process.pid };
}
`;

export interface KillChildStep {
	readonly export: "dieOnce" | "survive";
	readonly idempotent: boolean;
}

export interface KillChildStepOutcome {
	/** `ok`, or the error code the job failed with. */
	readonly result: string;
	/** The child generation the job finished on; only for `ok`. */
	readonly generation?: number;
}

export interface KillChildOutcome {
	readonly steps: readonly KillChildStepOutcome[];
	/** How many times the module body ran in total (a re-run counts again). */
	readonly runs: number;
}

export interface KillChildCase {
	readonly id: string;
	readonly placement: "fused";
	readonly kill: string;
	readonly steps: readonly KillChildStep[];
	readonly expected: KillChildOutcome;
	/** The tool child's lifecycle records, as `[state, generation]`. */
	readonly records: readonly (readonly [string, number])[];
}

export const KILL_CHILD_CASES: readonly KillChildCase[] = [
	{
		id: "KILL-CHILD-01",
		placement: "fused",
		kill: "the child dies in the middle of a strict module job",
		steps: [{ export: "dieOnce", idempotent: false }],
		expected: { steps: [{ result: "tool_child_exited" }], runs: 1 },
		records: [
			["spawned", 1],
			["exited", 1],
		],
	},
	{
		id: "KILL-CHILD-02",
		placement: "fused",
		kill: "the child dies in the middle of an idempotent module job",
		steps: [{ export: "dieOnce", idempotent: true }],
		expected: { steps: [{ result: "ok", generation: 2 }], runs: 2 },
		records: [
			["spawned", 1],
			["exited", 1],
			["respawned", 2],
		],
	},
	{
		id: "KILL-CHILD-03",
		placement: "fused",
		kill: "the child dies in a strict job, then the next job runs",
		steps: [
			{ export: "dieOnce", idempotent: false },
			{ export: "survive", idempotent: false },
		],
		expected: { steps: [{ result: "tool_child_exited" }, { result: "ok", generation: 2 }], runs: 2 },
		records: [
			["spawned", 1],
			["exited", 1],
			["respawned", 2],
		],
	},
];

/** Runs one case's steps on `dispatcher`, with `modulePath` holding {@link KILL_CHILD_MODULE}. */
export async function runKillChildCase(
	dispatcher: ToolDispatcher,
	modulePath: string,
	workDir: string,
	killCase: KillChildCase,
): Promise<KillChildOutcome> {
	const log = `${workDir}/${killCase.id}.log`;
	appendFileSync(log, "");
	const steps: KillChildStepOutcome[] = [];
	for (const [index, step] of killCase.steps.entries()) {
		const job = {
			modulePath,
			export: step.export,
			args: { log, marker: `${workDir}/${killCase.id}.marker`, toolCallId: `${killCase.id}-${index}` },
			idempotent: step.idempotent,
		};
		try {
			const outcome = await dispatcher.offload(job, undefined);
			steps.push({ result: "ok", generation: outcome.generation });
		} catch (error) {
			steps.push({ result: String(Reflect.get(Object(error), "code") ?? error) });
		}
	}
	const runs = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
	return { steps, runs };
}
