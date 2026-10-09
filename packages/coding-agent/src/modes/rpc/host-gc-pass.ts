/**
 * The budgeted gc pass `ensureHost` schedules after it has returned a host: the same per-endpoint
 * removal as `senpi host gc` (`gcEndpoint` - each endpoint's own ensure lock with its 2 s wait, the
 * three-part evidence, siblings/socket/directory in that order), run without an operator so dead
 * endpoint records stop accumulating under an agent directory.
 *
 * It is never on the awaited start path: `scheduleOpportunisticHostGc` returns at once and the pass
 * runs from an unref'd immediate, so a first child never waits on it, and a short-lived CLI process
 * simply exits under it (the marker is written only after a COMPLETED pass, so the next long-lived
 * process picks the work up). At most one pass per agent directory every `minIntervalMs`, stopped by
 * a time and a count budget. It never considers - and so never locks - the endpoint the ensure was
 * for, never signals, and never lowers the evidence bar.
 *
 * Fairness: endpoints are walked in sorted directory order starting AFTER the marker's `cursor` (the
 * last one the previous pass examined), wrapping around, so one uncollectable endpoint costs at most
 * one slot per pass and every endpoint is reached within ceil(total / maxEndpoints) passes. An
 * endpoint that stayed is skipped until its `skipUntil` (10 min, doubling to 24 h), so a stuck one
 * stops consuming budget altogether.
 */
import { appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHostDaemonPaths, sameEndpoint } from "./host-daemon-paths.ts";
import { type HostEndpointEntry, listHostEndpoints } from "./host-endpoints.ts";
import { gcEndpoint } from "./host-gc.ts";
import {
	type HostGcPassMarker,
	type HostGcSkipEntry,
	nextSkip,
	readHostGcPassMarker,
	writeHostGcPassMarker,
} from "./host-gc-pass-marker.ts";

export const OPPORTUNISTIC_GC_BUDGET = { budgetMs: 1_500, maxEndpoints: 32, minIntervalMs: 300_000 } as const;

export interface OpportunisticGcOptions {
	readonly agentDir: string;
	/** The endpoint the ensure was for: never judged, never locked. */
	readonly exclude: string;
	readonly budgetMs?: number;
	readonly maxEndpoints?: number;
	readonly minIntervalMs?: number;
	readonly now?: () => number;
}

export type OpportunisticGcOutcome =
	| { readonly ran: false }
	| { readonly ran: true; readonly marker: HostGcPassMarker };

type NamedEndpoint = HostEndpointEntry & { readonly socket: string; readonly name: string };

export async function gcHostEndpointsOpportunistically(
	options: OpportunisticGcOptions,
): Promise<OpportunisticGcOutcome> {
	const now = options.now ?? Date.now;
	const budgetMs = options.budgetMs ?? OPPORTUNISTIC_GC_BUDGET.budgetMs;
	const maxEndpoints = options.maxEndpoints ?? OPPORTUNISTIC_GC_BUDGET.maxEndpoints;
	const minIntervalMs = options.minIntervalMs ?? OPPORTUNISTIC_GC_BUDGET.minIntervalMs;
	const previous = await readHostGcPassMarker(options.agentDir);
	const startedAt = now();
	if (previous !== undefined && startedAt - previous.completedAt < minIntervalMs) return { ran: false };
	const candidates = await gcCandidates(options);
	const present = new Set(candidates.map((endpoint) => endpoint.name));
	const skip: Record<string, HostGcSkipEntry> = {};
	for (const [name, entry] of Object.entries(previous?.skip ?? {})) {
		if (present.has(name)) skip[name] = entry;
	}
	let cursor = previous?.cursor ?? null;
	let examined = 0;
	let removed = 0;
	let stoppedBy: HostGcPassMarker["stoppedBy"] = "exhausted";
	for (const endpoint of rotateAfter(candidates, cursor)) {
		if ((skip[endpoint.name]?.skipUntil ?? 0) > now()) continue;
		if (examined >= maxEndpoints) {
			stoppedBy = "count";
			break;
		}
		if (now() - startedAt >= budgetMs) {
			stoppedBy = "time";
			break;
		}
		examined += 1;
		cursor = endpoint.name;
		const outcome = await gcEndpoint(endpoint.socket, endpoint.dir, {}).catch(() => ({ removed: false }) as const);
		if (outcome.removed) {
			removed += 1;
			delete skip[endpoint.name];
		} else {
			skip[endpoint.name] = nextSkip(skip[endpoint.name], now());
		}
	}
	const marker: HostGcPassMarker = { completedAt: now(), cursor, examined, removed, stoppedBy, skip };
	await writeHostGcPassMarker(options.agentDir, marker);
	return { ran: true, marker };
}

const passesRunning = new Map<string, Promise<void>>();

/** Starts a pass off the caller's path; at most one at a time per agent directory in this process. */
export function scheduleOpportunisticHostGc(options: OpportunisticGcOptions): void {
	if (passesRunning.has(options.agentDir)) return;
	const pass = new Promise<void>((resolve) => {
		setImmediate(() => {
			gcHostEndpointsOpportunistically(options)
				.then(
					() => undefined,
					(error: unknown) => recordPassFailure(options.agentDir, error),
				)
				.finally(() => {
					passesRunning.delete(options.agentDir);
					resolve();
				});
		}).unref();
	});
	passesRunning.set(options.agentDir, pass);
}

/** Resolves once the pass this process scheduled for `agentDir` (if any) has finished; it never rejects. */
export function settledOpportunisticHostGc(agentDir: string): Promise<void> {
	return passesRunning.get(agentDir) ?? Promise.resolve();
}

async function gcCandidates(options: OpportunisticGcOptions): Promise<readonly NamedEndpoint[]> {
	const targetName = basename(createHostDaemonPaths({ socket: options.exclude, agentDir: options.agentDir }).dir);
	const candidates: NamedEndpoint[] = [];
	for (const endpoint of await listHostEndpoints(options.agentDir)) {
		const name = basename(endpoint.dir);
		if (endpoint.socket === null || name === targetName || sameEndpoint(endpoint.socket, options.exclude)) continue;
		candidates.push({ ...endpoint, socket: endpoint.socket, name });
	}
	return candidates;
}

function rotateAfter(endpoints: readonly NamedEndpoint[], cursor: string | null): readonly NamedEndpoint[] {
	if (cursor === null) return endpoints;
	const start = endpoints.findIndex((endpoint) => endpoint.name > cursor);
	return start <= 0 ? endpoints : [...endpoints.slice(start), ...endpoints.slice(0, start)];
}

async function recordPassFailure(agentDir: string, error: unknown): Promise<void> {
	const line = `${new Date().toISOString()} gc pass failed: ${error instanceof Error ? error.message : String(error)}\n`;
	await appendFile(join(agentDir, "rpc-host-daemon", "gc-pass.log"), line, { mode: 0o600 }).catch(
		(logError: unknown) => {
			// The agent directory itself is gone: nothing is left to collect or to report to.
			if (logError instanceof Error && "code" in logError && logError.code === "ENOENT") return;
			process.emitWarning(`host gc pass failed and could not be recorded: ${String(logError)}`);
		},
	);
}
