/**
 * A host from before layout 2: the process a FLAT `<agentDir>/rpc-host-daemon/host.pid` names.
 *
 * This build never writes and never removes that file. It is another process's state, and it is
 * the only evidence an updated client has that such a host may still own an endpoint. Two acts are
 * allowed on its strength, and both only while the record's identity guard (pid plus start time)
 * still matches the live process (a recycled pid proves nothing):
 *
 * - a DRAIN (SIGUSR1) against the endpoint the record describes, when that endpoint's host
 *   advertises `generation_handoff`. A drain ends no work, so `stop --drain` may send it;
 * - an ensure may drain it and take over when that host reports no session at all. With any
 *   session open, the ensure refuses with `legacy_host` and says how to retire it.
 *
 * Which endpoint a record describes: the last pre-layout-2 build stamped `socket` into it; an
 * unstamped record (older builds, and the desktop's own spawner) belongs to the agent directory's
 * default socket, the only endpoint those writers kept in the flat directory.
 */
import { dirname, join } from "node:path";
import { APP_NAME } from "../../config.ts";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	parseDaemonPidFile,
	processIsLive,
	processMatchesPidFile,
	readProcessStartTime,
} from "../app-server/daemon/process.ts";
import { type HostDaemonPaths, sameEndpoint } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "./host-decision.ts";
import { probeProtocolInfo, probeSessionCount } from "./host-probe.ts";
import { logUnknownHostIdentity } from "./host-supervisor-log.ts";

export interface LegacyHost {
	readonly record: DaemonPidFile;
	readonly socket: string;
}

/** What an ensure may do about a legacy host: nothing is there, drain it, or refuse and say why. */
type LegacyHostVerdict =
	| { readonly verdict: "absent" }
	| { readonly verdict: "idle"; readonly host: LegacyHost }
	| { readonly verdict: "held"; readonly detail: string };

const LEGACY_PROBE_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 50;

/**
 * An ensure's whole dealing with a legacy host: nothing to do, or drain an idle one and wait until it
 * is gone. Returns the refusal detail when the ensure must refuse `legacy_host` instead.
 */
export async function retireIdleLegacyHost(
	paths: HostDaemonPaths,
	probe: (pid: number) => Promise<string | undefined>,
	// A legacy drain has no supervised-child breaker: preserve its existing refusal bound.
	drainTimeoutMs: number = LEGACY_PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
	const judged = await judgeLegacyHost(paths, probe);
	if (judged.verdict === "absent") return undefined;
	if (judged.verdict === "held") return judged.detail;
	const { record, socket } = judged.host;
	if (await drainAndWait(record, probe, drainTimeoutMs)) return undefined;
	return `pid ${record.pid} (${socket}) was asked to drain and is still running after ${drainTimeoutMs}ms; retry once it exits`;
}

export async function readLegacyHost(paths: HostDaemonPaths): Promise<LegacyHost | undefined> {
	const text = await readFileOrUndefined(paths.legacyPidFile);
	const record = text === undefined ? undefined : parseDaemonPidFile(text);
	if (record === undefined) return undefined;
	const stamped = parseJson(text)?.socket;
	return { record, socket: typeof stamped === "string" ? stamped : join(dirname(paths.flatDir), "rpc", "rpc.sock") };
}

/** The legacy host serving `socket`, when its record PROVES which process that is; otherwise nothing. */
export async function provenLegacyOwner(
	paths: HostDaemonPaths,
	socket: string,
): Promise<{ pid: number; processStartTime: string } | undefined> {
	const legacy = await readLegacyHost(paths);
	const startTime = legacy?.record.processStartTime;
	if (!legacy || startTime === null || startTime === undefined || !sameEndpoint(legacy.socket, socket)) {
		return undefined;
	}
	const identity = { pid: legacy.record.pid, processStartTime: startTime };
	const proven = await processMatchesPidFile(identity, readProcessStartTime).catch((error: unknown) => {
		if (error instanceof ProcessIdentityUnreadableError) logUnknownHostIdentity("legacy_host.pid", identity.pid);
		return false;
	});
	return proven ? identity : undefined;
}

/**
 * Whether an ensure may retire the legacy host. `idle` only when the process is proven, its endpoint
 * answers with the drain capability, and the host lists no session - `list_sessions` with workers
 * included counts interactive, worker and retained sessions alike, so an idle host holds no work.
 * An identity that cannot be read on a live pid is `held`: it may still own an endpoint, and nothing
 * unproven is ever signalled.
 */
async function judgeLegacyHost(
	paths: HostDaemonPaths,
	probe: (pid: number) => Promise<string | undefined>,
	platform: NodeJS.Platform = process.platform,
): Promise<LegacyHostVerdict> {
	const host = await readLegacyHost(paths);
	if (host === undefined) return { verdict: "absent" };
	const { pid } = host.record;
	const identity = await processMatchesPidFile(host.record, probe).then(
		(owns) => (owns ? "proven" : "gone"),
		(error: unknown) => {
			if (error instanceof ProcessIdentityUnreadableError) return "unreadable";
			throw error;
		},
	);
	if (identity === "gone") return { verdict: "absent" };
	const where = `pid ${pid} (${host.socket})`;
	if (identity === "unreadable") {
		logUnknownHostIdentity("legacy_host.pid", pid);
		return {
			verdict: "held",
			detail: `${where} cannot be proven to be the process its record names; stop it by hand`,
		};
	}
	if (platform === "win32") {
		return { verdict: "held", detail: `${where} cannot be drained on win32; it exits once idle, then retry` };
	}
	const protocol = await probeProtocolInfo(host.socket, LEGACY_PROBE_TIMEOUT_MS);
	if (!protocol?.capabilities.includes(GENERATION_HANDOFF_CAPABILITY)) {
		return {
			verdict: "held",
			detail: `${where} ${protocol ? "cannot drain" : "does not answer"}; it is never signalled - stop it by hand, then retry`,
		};
	}
	const sessions = await probeSessionCount(host.socket, LEGACY_PROBE_TIMEOUT_MS);
	if (sessions === 0) return { verdict: "idle", host };
	return { verdict: "held", detail: busyLegacyHostDetail(pid, host.socket, sessions) };
}

/** Why a proven legacy host that holds work is left alone, and the command that retires it. */
export function busyLegacyHostDetail(pid: number, socket: string, sessions: number | undefined): string {
	return `pid ${pid} (${socket}) holds ${describeSessions(sessions)}; run \`${APP_NAME} host stop --drain --socket ${socket}\` to let it finish that work and exit, then retry`;
}

export function describeSessions(sessions: number | undefined): string {
	return sessions === undefined
		? "an unknown number of sessions"
		: `${sessions} open session${sessions === 1 ? "" : "s"}`;
}

/**
 * SIGUSR1, then wait for the proven process to leave. A host that exits before the signal lands has
 * already done what was asked (ESRCH). While waiting, an identity that cannot be read is NOT gone.
 */
async function drainAndWait(
	record: DaemonPidFile,
	probe: (pid: number) => Promise<string | undefined>,
	timeoutMs: number,
): Promise<boolean> {
	try {
		process.kill(record.pid, "SIGUSR1");
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
	const stillRunning = () =>
		processMatchesPidFile(record, probe, processIsLive, { attempts: 1 }).catch((error: unknown) => {
			if (error instanceof ProcessIdentityUnreadableError) return true;
			throw error;
		});
	const deadline = Date.now() + timeoutMs;
	while (await stillRunning()) {
		if (Date.now() > deadline) return false;
		await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
	}
	return true;
}
