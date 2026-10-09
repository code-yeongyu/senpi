/**
 * `senpi host gc`: reclaims the endpoint directories of hosts that are PROVABLY gone, and nothing else.
 *
 * Endpoint state accumulates by design - `endpoint.json` outlives every generation so `status --all`
 * can still name an endpoint whose host exited - and this is the only code that ever removes it. It has
 * two entry points on the same evidence: the operator command, and the budgeted pass `ensureHost`
 * schedules AFTER it returned a host (`host-gc-pass.ts`; never inside the ensure lock, never awaited
 * by the ensure, never from `status`). It never signals a process, and it
 * removes an endpoint only on three-part evidence evaluated INSIDE that endpoint's ensure lock, the one
 * `ensureHost` serializes on (`hostEnsureLockTarget`), so an ensure can neither start a host into a
 * directory being removed nor have its fresh registration removed under it. Every endpoint that fails
 * any part of the evidence is kept, with the reason:
 *
 *     live_generation   a generation pidfile (any, the pointer's included) names a live process
 *     live_claim        a session-path claim in `reservations/` has a live owner
 *     reachable         the socket (or a `.next-*` successor bind) did not refuse the connection
 *     locked            the ensure lock was not free within 2 s
 *     legacy_layout     the agent dir predates layout 2; its flat files belong to a legacy host
 *     unknown_identity  nothing in the directory names its socket, so its lock cannot be taken
 *     failed            reading the evidence or removing the endpoint threw; `error` says what
 *
 * A removal goes siblings first, the socket next and the endpoint directory LAST: until the directory
 * is gone the endpoint is still listed, so a removal that fails part-way is finished by a later gc
 * instead of leaving a socket nothing names. A sibling that is a directory is not a socket's leftover
 * and not gc's to delete; it stays, and is reported under `skipped`. One endpoint's failure is recorded
 * and the run goes on to the next.
 *
 * `kinds` narrows a run to endpoints of those `endpoint_kind`s - a TUI reaping dead `tui` endpoints at
 * its own startup - and every other endpoint is neither judged nor reported; the evidence rule for the
 * ones it does judge is the same three-part rule. The flat legacy directory is a host's, so it is only
 * reported when `rpc_host` is among the kinds.
 */
import { lstat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type EndpointKind, HOST_DAEMON_LAYOUT, hostDaemonDirectoryPaths } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { listHostEndpoints } from "./host-endpoints.ts";
import { acquireHostEnsureLock } from "./host-ensure-lock.ts";
import { type EndpointInUse, endpointInUse, type SocketSilence, socketSiblings } from "./host-gc-evidence.ts";

export type HostGcKeptReason = EndpointInUse | "locked" | "legacy_layout" | "unknown_identity" | "failed";

/** A sibling a removal left in place because of what it is. */
export interface HostGcSkippedEntry {
	readonly path: string;
	readonly type: "directory";
}

export interface HostGcEntry<Reason extends string> {
	readonly socket: string | null;
	readonly dir: string;
	readonly reason: Reason;
	/** Removed entries only, and only when a sibling was left in place. */
	readonly skipped?: readonly HostGcSkippedEntry[];
	/** `failed` entries only: the message of what threw. */
	readonly error?: string;
}

export interface HostGcResult {
	readonly removed: readonly HostGcEntry<SocketSilence>[];
	readonly kept: readonly HostGcEntry<HostGcKeptReason>[];
}

export interface HostGcOptions {
	/** Only endpoints of these kinds; every kind when absent. */
	readonly kinds?: readonly EndpointKind[];
	readonly _test?: {
		/** Runs inside an endpoint's ensure lock, before any evidence is read. */
		readonly afterLockAcquired?: (socket: string) => Promise<void>;
	};
}

/** 2 s, the budget a concurrent ensure's critical section gets before gc reports `locked`. */
const GC_LOCK_WAIT_MS = 2_000;

export async function gcHostEndpoints(agentDir: string, options: HostGcOptions = {}): Promise<HostGcResult> {
	const removed: HostGcEntry<SocketSilence>[] = [];
	const kept: HostGcEntry<HostGcKeptReason>[] = [];
	const wanted = (kind: EndpointKind): boolean => options.kinds === undefined || options.kinds.includes(kind);
	const legacy = wanted("rpc_host") ? await legacyFlatDirectory(agentDir) : undefined;
	if (legacy !== undefined) kept.push({ socket: null, dir: legacy, reason: "legacy_layout" });
	for (const endpoint of await listHostEndpoints(agentDir)) {
		if (!wanted(endpoint.endpoint_kind)) continue;
		if (endpoint.socket === null) {
			kept.push({ socket: null, dir: endpoint.dir, reason: "unknown_identity" });
			continue;
		}
		const entry = { socket: endpoint.socket, dir: endpoint.dir };
		try {
			const outcome = await gcEndpoint(endpoint.socket, endpoint.dir, options);
			if (!outcome.removed) kept.push({ ...entry, reason: outcome.reason });
			else if (outcome.skipped.length === 0) removed.push({ ...entry, reason: outcome.reason });
			else removed.push({ ...entry, reason: outcome.reason, skipped: outcome.skipped });
		} catch (error: unknown) {
			kept.push({ ...entry, reason: "failed", error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { removed, kept };
}

/** One endpoint, judged and removed exactly as a full run does; the budgeted pass (`host-gc-pass.ts`) reuses it. */
export async function gcEndpoint(
	socket: string,
	dir: string,
	options: HostGcOptions,
): Promise<
	| { readonly removed: true; readonly reason: SocketSilence; readonly skipped: readonly HostGcSkippedEntry[] }
	| { readonly removed: false; readonly reason: HostGcKeptReason }
> {
	const release = await acquireEnsureLock(socket);
	if (release === undefined) return { removed: false, reason: "locked" };
	try {
		await options._test?.afterLockAcquired?.(socket);
		const evidence = await endpointInUse(hostDaemonDirectoryPaths(dir), socket);
		if (evidence.inUse !== undefined) return { removed: false, reason: evidence.inUse };
		const skipped = await removeEndpoint(socket, dir);
		return { removed: true, reason: evidence.silence, skipped };
	} finally {
		await release();
	}
}

/** Siblings by their actual type, then the socket, then the directory that lists the endpoint. */
async function removeEndpoint(socket: string, dir: string): Promise<readonly HostGcSkippedEntry[]> {
	const skipped: HostGcSkippedEntry[] = [];
	for (const sibling of await socketSiblings(socket)) {
		const path = join(dirname(socket), sibling);
		const entry = await lstat(path).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (entry?.isDirectory()) skipped.push({ path, type: "directory" });
		else if (entry !== undefined) await rm(path, { force: true });
	}
	await rm(socket, { force: true });
	await rm(dir, { recursive: true, force: true });
	return skipped;
}

/** The ensure lock of `socket`, taken exactly as `ensureHost` takes it; `undefined` when not free in time. */
async function acquireEnsureLock(socket: string): Promise<(() => Promise<void>) | undefined> {
	return acquireHostEnsureLock(socket, GC_LOCK_WAIT_MS).catch(() => undefined);
}

/** The flat daemon directory when it holds state but no layout-2 marker: a legacy host's, never touched. */
async function legacyFlatDirectory(agentDir: string): Promise<string | undefined> {
	const flatDir = join(agentDir, "rpc-host-daemon");
	const marker = parseJson(await readFileOrUndefined(join(flatDir, "layout.json")).catch(() => undefined));
	if (marker?.layout === HOST_DAEMON_LAYOUT) return undefined;
	const hasState = (await readFileOrUndefined(join(flatDir, "host.pid")).catch(() => undefined)) !== undefined;
	return hasState ? flatDir : undefined;
}
