import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { z } from "zod";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { AgentToolResult, InlineExtension } from "../../src/index.ts";
import { assistantMessage, opened, threadCount } from "./rpc-inprocess-host-metrics.ts";
import {
	type LoadHost,
	latencyLine,
	openDescriptorCount,
	report,
	round,
	rssMb,
	softFileLimit,
} from "./rpc-inprocess-load-support.ts";

/** Cadence the neighbour probe issues `get_state` at, as the load todo specifies. */
const PROBE_INTERVAL_MS = 100;
/** Duration of the tool a load cell parks a session inside. */
export const SLOW_TOOL_MS = 3_000;

const churnSchema = z.object({
	cycles: z.number(),
	concurrency: z.number(),
	elapsedMs: z.number(),
	rssBeforeMb: z.number(),
	rssAfterMb: z.number(),
	heapBeforeMb: z.number(),
	heapAfterMb: z.number(),
	threadsBefore: z.number(),
	threadsAfter: z.number(),
	importerBefore: z.object({ generations: z.number(), plugins: z.number() }),
	importerAfter: z.object({ generations: z.number(), plugins: z.number() }),
	sessionsLeft: z.number(),
	errors: z.number(),
});
export type ChurnReport = z.infer<typeof churnSchema>;

const toolResult = (text: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text }], details: {} });

/**
 * The real omo plugin bundle the launcher and the desktop already resolve, or an
 * empty list when this machine has no omo installed (the plugin cell then records
 * that instead of measuring a bundle it invented).
 */
export function resolveOmoPluginExtensions(): readonly string[] {
	const root =
		process.env.SENPI_LOAD_OMO_PLUGIN ??
		join(homedir(), ".bun", "install", "global", "node_modules", "omo-ai", "plugin", "extensions");
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((entry) => entry.endsWith(".js"))
		.map((entry) => join(root, entry));
}

/** Z-state children of one process: exited children nobody has waited on. */
export function zombieCount(pid: number): number {
	return execFileSync("ps", ["-axo", "ppid=,stat="], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([parent, stat]) => Number(parent) === pid && stat?.startsWith("Z")).length;
}

/** Opens one worker-kind session; a refused open fails the cell with the host's reason. */
export async function openWorker(host: LoadHost, index: number, sessionPath?: string) {
	return opened(
		await host.send({
			type: "open_session",
			cwd: host.cwd,
			kind: "worker",
			auto_title: false,
			...(sessionPath === undefined ? {} : { sessionPath }),
		}),
		index,
	);
}

/** A tool that occupies its session for `SLOW_TOOL_MS` WITHOUT holding the event loop. */
export const slowAsyncTool: InlineExtension = (pi) => {
	pi.registerTool({
		name: "slow_async",
		label: "Slow async",
		description: "Occupies the calling session asynchronously",
		parameters: Type.Object({}),
		execute: async () => {
			await new Promise((settle) => setTimeout(settle, SLOW_TOOL_MS));
			return toolResult("slow_async done");
		},
	});
};

/**
 * The deliberately WRONG shape, for contrast only: a tool that blocks the host
 * loop for `SLOW_TOOL_MS`. Never a product path - it exists so the neighbour cell
 * can show what the async tool's number is being compared against.
 */
export const blockingTool: InlineExtension = (pi) => {
	pi.registerTool({
		name: "slow_sync",
		label: "Slow sync",
		description: "Blocks the host loop",
		parameters: Type.Object({}),
		execute: () => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOW_TOOL_MS);
			return Promise.resolve(toolResult("slow_sync done"));
		},
	});
};

/** Arms the faux provider with `count` identical text turns, so no stream ever runs dry. */
export function fillResponsePool(host: LoadHost, count: number): void {
	host.faux.setResponses(Array.from({ length: count }, () => () => fauxAssistantMessage("load")));
}

/** Queues the two faux turns one tool call costs: the call, then the reply after its result. */
export function queueToolTurn(host: LoadHost, tool: string): void {
	host.faux.appendResponses([
		fauxAssistantMessage([fauxToolCall(tool, {})], { stopReason: "toolUse" }),
		fauxAssistantMessage(`${tool} acknowledged`),
	]);
}

/**
 * Resolves when the session's turn has fully settled.
 *
 * `prompt` answers `{ disposition: "started" }` as soon as the turn is accepted, so
 * the response is NOT the window a neighbour cell probes inside - `agent_idle` is.
 */
export function settled(host: LoadHost, sessionId: string): Promise<unknown> {
	return host.nextRecord(sessionId, (record) => record.type === "agent_idle");
}

/** The CHURN cell's line: what the process kept after every session was closed. */
export function churnLine(churn: ChurnReport): string {
	return (
		`(ii) cycles=${churn.cycles} errors=${churn.errors} elapsed=${churn.elapsedMs}ms ` +
		`rss=${churn.rssBeforeMb}->${churn.rssAfterMb}MB heap=${churn.heapBeforeMb}->${churn.heapAfterMb}MB ` +
		`threads=${churn.threadsBefore}->${churn.threadsAfter} ` +
		`importer=${JSON.stringify(churn.importerBefore)}->${JSON.stringify(churn.importerAfter)}`
	);
}

/**
 * Opens `sessions` worker sessions with the plugin bundle already on the host's argv
 * and prints what each one cost in memory and file descriptors. Recording only: the
 * numbers depend on the bundle, which is not this repository's artifact.
 */
export async function measurePluginCell(host: LoadHost, bundle: number, sessions: number): Promise<void> {
	const rssBefore = rssMb();
	const descriptorsBefore = openDescriptorCount(process.pid);
	for (let index = 0; index < sessions; index++) await openWorker(host, index);
	const descriptors = openDescriptorCount(process.pid) - descriptorsBefore;
	report(
		`(v) plugin=${bundle} sessions=${sessions} rss=${rssBefore}->${rssMb()}MB ` +
			`(${round((rssMb() - rssBefore) / sessions)}MB/session) fd=${descriptorsBefore}->` +
			`${openDescriptorCount(process.pid)} (${round(descriptors / sessions)}/session) ` +
			`threads=${threadCount(process.pid)} rlimitNofileSoft=${softFileLimit()}`,
	);
}

export interface ProbeSamples {
	/** Round-trip of each `get_state`, in milliseconds. */
	readonly latencies: readonly number[];
	/** Wall gap between consecutive completed probes: what a frozen loop shows up in. */
	readonly gaps: readonly number[];
}

/**
 * Issues `get_state` on `sessionId` every `PROBE_INTERVAL_MS` until `until` settles.
 * The interval is the measurement cadence this cell is defined by, not a wait for a
 * result: the loop's exit is the awaited event.
 */
export async function probeGetState(host: LoadHost, sessionId: string, until: Promise<unknown>): Promise<ProbeSamples> {
	const latencies: number[] = [];
	const gaps: number[] = [];
	let running = true;
	const stop = () => {
		running = false;
	};
	// Settled or failed, the window is over; the caller awaits `until` for its outcome.
	until.then(stop, stop);
	let previous = performance.now();
	while (running) {
		const started = performance.now();
		const response = await host.send({ type: "get_state", sessionId });
		if (response?.success !== true) throw new Error(`get_state failed: ${JSON.stringify(response)}`);
		const finished = performance.now();
		latencies.push(finished - started);
		gaps.push(finished - previous);
		previous = finished;
		if (!running) break;
		await new Promise((tick) => setTimeout(tick, PROBE_INTERVAL_MS));
	}
	return { latencies, gaps };
}

/** One neighbour probe's line, including the gap a frozen loop shows up in. */
export function probeLine(label: string, samples: ProbeSamples): string {
	return `${latencyLine(label, samples.latencies)} gapMax=${round(Math.max(...samples.gaps))}ms`;
}

/** Writes a real session transcript of at least `bytes` and returns its path. */
export function writeLargeTranscript(dir: string, bytes: number): string {
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	const block = "x".repeat(1_000_000);
	const file = manager.getSessionFile();
	if (!file) throw new Error("SessionManager.create produced no session file");
	do manager.appendMessage(assistantMessage(block));
	while (statSync(file).size < bytes);
	return file;
}

/**
 * Runs the churn cell on BUN, the runtime the daemon ships, in its own process.
 *
 * Two reasons it is not inline: `bunExtensionImporterStats()` counts graphs the
 * BUN extension importer registers, and the vitest runtime is Node (verified:
 * `typeof Bun === "undefined"`), where that counter can only ever read zero; and
 * only Bun can force the full GC that separates "retained" from "not yet swept".
 * Same shape as `test/extensions/bun-extension-regressions.test.ts`, which spawns
 * `bun` for exactly the same reason.
 */
export async function runChurnCell(cycles: number, concurrency: number): Promise<ChurnReport> {
	const script = resolve(import.meta.dirname, "..", "..", "scripts", "qa-rpc-socket", "load-churn.mjs");
	const { stdout } = await promisify(execFile)(
		"bun",
		[script, "--cycles", String(cycles), "--concurrency", String(concurrency)],
		{ cwd: resolve(import.meta.dirname, "..", ".."), maxBuffer: 8 * 1024 * 1024 },
	);
	const reported = stdout.trim().split("\n").at(-1);
	if (!reported) throw new Error("load-churn.mjs produced no report line");
	return churnSchema.parse(JSON.parse(reported));
}
