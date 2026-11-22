/**
 * The stop intent: written by whoever is about to signal a host generation, BEFORE the signal, into
 * THAT generation's directory (`generations/<instanceId>/stop-intent.json`), so the record written when
 * the generation ends can name who stopped it and why (senpi#2566).
 *
 * It is scoped to the target generation because a successor shares the endpoint directory with its
 * predecessor during a handoff: an endpoint-wide file would let one generation's exit consume the
 * other's intent. No code path reads or removes another generation's file. This is the one sanctioned
 * cross-writer of generation state (rpc `AGENTS.md`, I3): the sender writes into the target's directory
 * because the target cannot know who is about to stop it.
 *
 * Writing is best-effort and never blocks the signal it precedes. A drain (SIGUSR1) writes nothing:
 * it ends no work.
 *
 * The drain REQUEST lives here too, as the other cross-writer record (senpi#3653): the signal-free way to ask one
 * named generation to drain, on every platform. `drain-request.json` is written by whoever asks (`host stop
 * --drain`) into the target generation's directory and read by its supervisor; `host-drain-request.json` is the
 * supervisor's relay to its host child. A generation advertises that it reads requests through
 * `drain-watch.json`, naming the supervisor pid that armed the watch; an asker trusts that marker only together
 * with an identity proof of that pid. Every request carries a fresh nonce and a watcher delivers each nonce once;
 * an unreadable file is never read as a request, and the reader never removes it. One module because both records
 * are part of the lifecycle supervisor's startup graph, which has a module budget
 * (test/supervisor-import-graph.test.ts).
 */
import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { HostStopSender } from "./host-crash-record.ts";
import { HOST_DAEMON_DIR_ENV, type HostGenerationPaths, hostDaemonDirectoryPaths } from "./host-daemon-paths.ts";
import { generationPaths } from "./host-generation-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import { ageOf, readJsonObject, writeJsonAtomic } from "./host-state-json.ts";

/** An intent older than this describes some earlier stop, not the death being recorded now. */
export const STOP_INTENT_MAX_AGE_MS = 120_000;

/** Shared with callers so they never kill a supervisor while it is reaping its child. */
export const CHILD_STOP_TIMEOUT_MS = 5_000;
export const CHILD_KILL_EXIT_TIMEOUT_MS = 30_000;

const SENDER_KINDS: ReadonlySet<string> = new Set(["ensure", "supervisor", "stop", "successor", "handoff"]);

export interface HostStopIntent {
	readonly sender: HostStopSender;
	/** Present once a second sender acted on the same stop (the supervisor after an outer caller). */
	readonly chain?: readonly HostStopSender[];
	readonly targetPid: number;
	readonly reason: string;
	readonly signal: string;
	readonly at: string;
}

export async function writeStopIntent(
	generation: HostGenerationPaths,
	intent: HostStopIntent,
	log: (message: string) => void = (message) => void process.stderr.write(`${message}\n`),
): Promise<void> {
	try {
		await writeJsonAtomic(generation.stopIntentFile, intent);
	} catch (cause) {
		log(`could not record the stop intent for ${generation.dir}: ${cause instanceof Error ? cause.message : cause}`);
	}
}

/** This generation's own intent while it is fresh; a stale one is removed and reads as none. */
export async function readStopIntent(
	generation: HostGenerationPaths,
	options: { readonly now?: number; readonly maxAgeMs?: number } = {},
): Promise<HostStopIntent | undefined> {
	const raw = await readJsonObject(generation.stopIntentFile);
	if (raw === undefined) return undefined;
	const intent = parseStopIntent(raw);
	const age = ageOf(raw.at, options.now ?? Date.now());
	if (intent !== undefined && age !== undefined && age <= (options.maxAgeMs ?? STOP_INTENT_MAX_AGE_MS)) return intent;
	await clearStopIntent(generation);
	return undefined;
}

/** Read-and-clear: the record that cites the intent is the intent's only consumer. */
export async function consumeStopIntent(
	generation: HostGenerationPaths,
	now: number = Date.now(),
): Promise<HostStopIntent | undefined> {
	const intent = await readStopIntent(generation, { now });
	if (intent !== undefined) await clearStopIntent(generation);
	return intent;
}

export async function clearStopIntent(generation: HostGenerationPaths): Promise<void> {
	await rm(generation.stopIntentFile, { force: true }).catch(() => undefined);
}

/**
 * The supervisor's own intent before it signals its child. An OUTER intent for this generation (an
 * ensure, `host stop`, a handoff) is never overwritten: the supervisor appends itself to its chain and
 * its shutdown reason to the outer reason, so the record keeps naming the original sender.
 */
export function layeredSupervisorIntent(
	outer: HostStopIntent | undefined,
	supervisor: HostStopSender,
	stop: { readonly targetPid: number; readonly reason: string; readonly at: string },
): HostStopIntent {
	if (outer === undefined) return { sender: supervisor, signal: "SIGTERM", ...stop };
	return {
		sender: outer.sender,
		chain: [...(outer.chain ?? [outer.sender]), supervisor],
		targetPid: stop.targetPid,
		reason: `${outer.reason} -> ${stop.reason}`,
		signal: "SIGTERM",
		at: stop.at,
	};
}

function parseStopIntent(raw: Record<string, unknown>): HostStopIntent | undefined {
	const sender = parseSender(raw.sender);
	const chain = Array.isArray(raw.chain) ? raw.chain.map(parseSender) : undefined;
	if (sender === undefined || chain?.some((entry) => entry === undefined)) return undefined;
	if (typeof raw.reason !== "string" || typeof raw.at !== "string") return undefined;
	return {
		sender,
		...(chain ? { chain: chain.filter((entry) => entry !== undefined) } : {}),
		targetPid: typeof raw.targetPid === "number" ? raw.targetPid : 0,
		reason: raw.reason,
		signal: typeof raw.signal === "string" ? raw.signal : "SIGTERM",
		at: raw.at,
	};
}

function parseSender(value: unknown): HostStopSender | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const pid = Reflect.get(value, "pid");
	const kind = Reflect.get(value, "kind");
	const generation = Reflect.get(value, "generation");
	if (typeof pid !== "number" || typeof kind !== "string" || !isSenderKind(kind)) return undefined;
	return { pid, kind, ...(typeof generation === "string" ? { generation } : {}) };
}

function isSenderKind(kind: string): kind is HostStopSender["kind"] {
	return SENDER_KINDS.has(kind);
}

/** How often a generation looks for a drain request when it cannot watch the directory: the supersession cadence. */
export const DRAIN_REQUEST_POLL_MS = 1_000;
/**
 * The backup poll while the directory watch is armed (senpi#3747): the watch delivers a request as it lands,
 * so an idle generation no longer reads the file every second; the poll only covers an event the watch missed.
 */
export const DRAIN_REQUEST_WATCHED_POLL_MS = 5_000;

export interface HostDrainRequest {
	readonly sender: HostStopSender;
	readonly reason: string;
	readonly at: string;
	/** Distinguishes one request from the next; a watcher delivers each nonce once. */
	readonly nonce: string;
}

/** Records a drain request for whoever polls `file`. Atomic: a reader sees no request or a whole one. */
export async function writeDrainRequest(
	file: string,
	request: { readonly sender: HostStopSender; readonly reason: string },
): Promise<void> {
	const record: HostDrainRequest = { ...request, at: new Date().toISOString(), nonce: randomUUID() };
	await writeJsonAtomic(file, record);
}

/**
 * Calls `onRequest` for every distinct request that appears at `file`, including one already there
 * when the watch arms. The file's directory is watched, so a request is read when it lands; a poll every
 * `DRAIN_REQUEST_WATCHED_POLL_MS` backs the watch up, and every `DRAIN_REQUEST_POLL_MS` when the directory
 * cannot be watched. `pollMs` overrides the poll interval. Unref'd: a drain watch must never be the reason a
 * process stays up.
 */
export function watchDrainRequest(
	file: string,
	onRequest: (request: HostDrainRequest) => void,
	options: { readonly pollMs?: number } = {},
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let watcher: FSWatcher | undefined;
	let polling = false;
	let lastNonce: string | undefined;
	const poll = (): void => {
		if (stopped || polling) return;
		polling = true;
		void readDrainRequest(file)
			.then((request) => {
				if (stopped || request === undefined || request.nonce === lastNonce) return;
				lastNonce = request.nonce;
				onRequest(request);
			}, ignore)
			.finally(() => {
				polling = false;
			});
	};
	const schedule = (intervalMs: number): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = setInterval(poll, options.pollMs ?? intervalMs);
		timer.unref?.();
	};
	const name = basename(file);
	try {
		watcher = watch(dirname(file), { persistent: false }, (_event, changed) => {
			if (changed === null || changed === name) poll();
		});
		watcher.on("error", () => {
			watcher?.close();
			watcher = undefined;
			if (!stopped) schedule(DRAIN_REQUEST_POLL_MS);
		});
	} catch {
		watcher = undefined;
	}
	schedule(watcher === undefined ? DRAIN_REQUEST_POLL_MS : DRAIN_REQUEST_WATCHED_POLL_MS);
	poll();
	return () => {
		stopped = true;
		if (timer !== undefined) clearInterval(timer);
		watcher?.close();
	};
}

/** The request at `file`, or nothing when it is absent or does not parse as one. */
export async function readDrainRequest(file: string): Promise<HostDrainRequest | undefined> {
	const raw = await readJsonObject(file);
	if (raw === undefined) return undefined;
	const sender = parseSender(raw.sender);
	if (sender === undefined) return undefined;
	if (typeof raw.reason !== "string" || typeof raw.at !== "string" || typeof raw.nonce !== "string") return undefined;
	return {
		sender,
		reason: raw.reason,
		at: raw.at,
		nonce: raw.nonce,
	};
}

/** What a supervisor publishes once its watch is armed: the pid an asker must prove before asking. */
export interface HostDrainWatch {
	readonly pid: number;
}

export async function writeDrainWatch(file: string, watch: HostDrainWatch): Promise<void> {
	await writeJsonAtomic(file, { ...watch, at: new Date().toISOString() });
}

/** The advertised watcher pid, or nothing: a generation without the marker cannot be asked this way. */
export async function readDrainWatch(file: string): Promise<HostDrainWatch | undefined> {
	const raw = await readFileOrUndefined(file);
	if (raw === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		const pid = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "pid") : undefined;
		return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The relay file a SUPERVISED host child polls, derived from what its supervisor told it at spawn
 * (daemon directory + instance id). A host started bare has no supervisor to relay anything.
 */
export function hostChildDrainRequestFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const daemonDir = env[HOST_DAEMON_DIR_ENV];
	const instanceId = env[HOST_INSTANCE_ID_ENV];
	if (!daemonDir || !instanceId) return undefined;
	return generationPaths(hostDaemonDirectoryPaths(daemonDir), instanceId).childDrainRequestFile;
}

async function readFileOrUndefined(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

function ignore(): void {}
