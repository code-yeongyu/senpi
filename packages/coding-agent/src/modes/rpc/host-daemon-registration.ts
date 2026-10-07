/**
 * What a running daemon's records SAY, and who is allowed to act on what they say.
 *
 * Two files describe a running daemon, and that split is the point:
 *
 * - the POINTER (`<daemonDir>/host.pid`) names the generation that currently owns the socket, and
 *   carries no `pid` or `processStartTime` key, so a client from before layout 2 can neither parse
 *   it nor derive a pid to signal from it;
 * - `generations/<instanceId>/host.pid` is the RECORD of one generation: which process serves the
 *   socket, which identity guards that pid, which build it runs, and who registered it.
 *
 * Three fields carry the evidence invariant I1 rests on (never terminate, signal or replace a host
 * you did not start), and each exists because a specific mistake is otherwise unprovable:
 *
 * - `processStartTime` - a pid alone is recycled by the OS, so a stale record would authorize a
 *   signal to an unrelated process.
 * - `writer` - the identity of the process that WROTE the record. Only that process may stop the
 *   host it names; anyone else attaches or refuses.
 * - `instance_id` - which generation the pointer is about, so a predecessor draining after a handoff
 *   removes its own directory and leaves the successor's registration alone.
 *
 * Where those files LIVE, and the modes they are written with, belong to `host-daemon-state.ts`;
 * this module reads and writes through its primitives and never builds a path of its own.
 */
import { rename, rm } from "node:fs/promises";
import type { EngineOrdinal } from "../../core/engine-build-identity.ts";
import {
	type DaemonPidFile,
	parseDaemonPidFile,
	processMatchesPidFile,
	readProcessStartTime,
} from "../app-server/daemon/process.ts";
import {
	createGenerationDirectory,
	generationPaths,
	HOST_DAEMON_LAYOUT,
	type HostDaemonPaths,
	type HostGenerationPaths,
	sameEndpoint,
} from "./host-daemon-paths.ts";
import { isRecord, parseJson, readFileOrUndefined, writeStateFile } from "./host-daemon-state.ts";
import { pruneDeadGenerations } from "./host-generations.ts";

/** Who wrote a registration: the process identity a later stop must match to be allowed. */
export interface HostPidFileWriter {
	readonly pid: number;
	readonly startTime: string | null;
}

/** What an ensure knows about the generation it just spawned. */
export interface HostRegistration {
	readonly record: DaemonPidFile;
	readonly socket: string;
	readonly instanceId: string;
	readonly generation: number;
	/** The profile the spawned host was launched with, for a client comparing two generations. */
	readonly launchProfileId: string;
	/**
	 * The build of the process this record names. Absent while it is not known yet (a handoff's
	 * successor before it answers): the record then claims no engine version rather than the writer's.
	 */
	readonly build?: { readonly text: string; readonly ordinal: EngineOrdinal };
}

export interface RegisteredHost {
	readonly record: DaemonPidFile;
	readonly writer?: HostPidFileWriter;
	/** The endpoint this record is about. Absent in records written before the field existed. */
	readonly socket?: string;
	readonly instanceId: string;
	readonly generation: number;
}

/**
 * The generation the pointer names, or nothing. A pointer without a readable generation record
 * describes no process, so it authorizes nothing - the next ensure overwrites it.
 */
export async function readHostRegistration(paths: HostDaemonPaths): Promise<RegisteredHost | undefined> {
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile));
	if (!pointer || typeof pointer.instance_id !== "string") return undefined;
	const text = await readFileOrUndefined(generationPaths(paths, pointer.instance_id).pidFile);
	const record = text === undefined ? undefined : parseDaemonPidFile(text);
	if (record === undefined) return undefined;
	const parsed = parseJson(text) ?? {};
	const writer = parseWriter(parsed);
	return {
		record,
		...(writer && { writer }),
		...(typeof parsed.socket === "string" && { socket: parsed.socket }),
		instanceId: pointer.instance_id,
		generation: typeof parsed.generation === "number" ? parsed.generation : 0,
	};
}

/**
 * Registers a generation and points the daemon directory at it, under this process's writer stamp.
 * The stamp is what authorizes a later stop: only the process that wrote a record may signal the
 * host it names, and the recorded start time keeps a recycled pid from inheriting that right.
 *
 * `fresh` says the directory cannot hold an earlier generation (a terminal's endpoint, named by a
 * socket built from a new instance id), so there is nothing to prune.
 */
export async function writeHostRegistration(
	paths: HostDaemonPaths,
	registration: HostRegistration,
	options: { readonly fresh?: boolean } = {},
): Promise<void> {
	// Every write is also the moment to drop what is no longer running: records of dead generations
	// and their session-path claims otherwise accumulate for the life of the agent directory, and a
	// stale pointer among them reads as "a daemon serves this endpoint" (#1893).
	if (options.fresh !== true) await pruneDeadGenerations(paths);
	const { generation, writer } = await writeGenerationRecord(paths, registration);
	// The pointer is replaced by rename: a reader either sees the generation that owned the socket
	// before this call or the one that owns it now, never a half-written pointer.
	await writeStateFile(`${paths.pointerFile}.${process.pid}.tmp`, {
		layout: HOST_DAEMON_LAYOUT,
		instance_id: registration.instanceId,
		generation_dir: generation.relativeDir,
		writer,
	});
	await rename(`${paths.pointerFile}.${process.pid}.tmp`, paths.pointerFile);
}

/**
 * Records ONE generation's process in its own directory without moving the pointer. A handoff writes
 * this the moment its successor is spawned: until the rename lands the pointer must keep naming the
 * predecessor, yet the successor is already running, and `host gc` has to see that from its own record
 * rather than judge the endpoint by a predecessor that may have died.
 */
export async function writeGenerationRecord(
	paths: HostDaemonPaths,
	registration: HostRegistration,
): Promise<{ generation: HostGenerationPaths; writer: HostPidFileWriter }> {
	const generation = generationPaths(paths, registration.instanceId);
	const writer: HostPidFileWriter = { pid: process.pid, startTime: await thisProcessStartTime() };
	const { build } = registration;
	await createGenerationDirectory(generation);
	await writeStateFile(generation.pidFile, {
		...registration.record,
		instance_id: registration.instanceId,
		generation: registration.generation,
		...(build && { engineVersion: build.text, engineOrdinal: build.ordinal }),
		launchProfileId: registration.launchProfileId,
		socket: registration.socket,
		writer,
	});
	return { generation, writer };
}

/** Drops the pointer, the generation it names and the boot settings: the host behind them is gone. */
export async function clearHostRegistration(paths: HostDaemonPaths): Promise<void> {
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile));
	if (typeof pointer?.instance_id === "string") {
		await rm(generationPaths(paths, pointer.instance_id).dir, { recursive: true, force: true });
	}
	await rm(paths.settingsFile, { force: true });
	// Last: "no pointer" is what every reader takes as "no host here" (senpi#2241).
	await rm(paths.pointerFile, { force: true });
}

/**
 * Drops ONE generation's registration while the files still name it. After a handoff the pointer
 * belongs to the successor, so a draining predecessor removes only its own directory - taking the
 * pointer with it would leave every client reading no daemon at all while one is serving.
 *
 * A generation whose public socket another one TOOK (`superseded`) removes only its own directory,
 * whatever the pointer says. The pointer and `settings.json` are then the replacer's to move: a handoff
 * rewrites the settings before its successor boots and repoints the pointer only after it saw the rename
 * land, and a predecessor that noticed the rename first would read "still mine" and remove both just as,
 * or just after, the handoff moved them - leaving the successor serving with no registration (#2536).
 */
export async function releaseGeneration(
	paths: HostDaemonPaths,
	owner: { readonly instanceId: string; readonly pid: number; readonly superseded?: boolean },
): Promise<void> {
	const generation = generationPaths(paths, owner.instanceId);
	const record = parseDaemonPidFile((await readFileOrUndefined(generation.pidFile)) ?? "");
	if (record !== undefined && record.pid !== owner.pid) return;
	if (owner.superseded === true) {
		await rm(generation.dir, { recursive: true, force: true });
		return;
	}
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile));
	const ownsPointer = pointer?.instance_id === owner.instanceId;
	if (ownsPointer) await rm(paths.settingsFile, { force: true });
	await rm(generation.dir, { recursive: true, force: true });
	// Last: "no pointer" is what every reader takes as "no host here" (senpi#2241).
	if (ownsPointer) await rm(paths.pointerFile, { force: true });
}

/**
 * Drops the pointer and the boot settings while the pointer still names `instanceId`, and leaves that
 * generation's directory to the generation itself: `host stop` signals a supervisor that still reads
 * its stop intent from there before it releases it.
 */
export async function releaseRegistrationPointer(paths: HostDaemonPaths, instanceId: string): Promise<void> {
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile));
	if (pointer?.instance_id !== instanceId) return;
	await rm(paths.settingsFile, { force: true });
	// Last: "no pointer" is what every reader takes as "no host here" (senpi#2241).
	await rm(paths.pointerFile, { force: true });
}

/**
 * The generation serving this socket, when - and only when - its record PROVES which process that
 * is. An owner nobody can prove may not be signalled at all (I1), so an unreadable identity, a
 * missing guard or a record about another endpoint all read as "no owner".
 */
export async function provenOwner(
	registered: RegisteredHost | undefined,
	socket: string,
): Promise<{ pid: number; processStartTime: string; instanceId: string } | undefined> {
	const record = registered?.record;
	if (!record || record.processStartTime === null) return undefined;
	if (registered?.socket !== undefined && !sameEndpoint(registered.socket, socket)) return undefined;
	const identity = { pid: record.pid, processStartTime: record.processStartTime };
	return (await processMatchesPidFile(identity, readProcessStartTime).catch(() => false))
		? { ...identity, instanceId: registered.instanceId }
		: undefined;
}

/**
 * I1 in one predicate: the registration names a host THIS process started. A writer that cannot be
 * proven ours reads as foreign, so the worst case of an unreadable identity is a refusal rather
 * than a signal sent to another owner's host.
 */
export async function writtenByThisProcess(
	writer: HostPidFileWriter | undefined,
	readStartTime?: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
	if (writer === undefined || writer.pid !== process.pid || writer.startTime === null) return false;
	const startTime = readStartTime
		? await readStartTime(process.pid).then(
				(value) => value ?? null,
				() => null,
			)
		: await thisProcessStartTime();
	return writer.startTime === startTime;
}

let selfStartTime: Promise<string | null> | undefined;

export function thisProcessStartTime(): Promise<string | null> {
	selfStartTime ??= readProcessStartTime(process.pid).then(
		(value) => value ?? null,
		() => null,
	);
	return selfStartTime;
}

/** A record from a host started before writer stamps existed simply has no writer: it reads as foreign. */
function parseWriter(parsed: Record<string, unknown>): HostPidFileWriter | undefined {
	if (!isRecord(parsed.writer) || typeof parsed.writer.pid !== "number") return undefined;
	const { pid, startTime } = parsed.writer;
	return { pid, startTime: typeof startTime === "string" ? startTime : null };
}
