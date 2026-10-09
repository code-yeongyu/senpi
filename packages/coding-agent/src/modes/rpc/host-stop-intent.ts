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
 */
import { rm } from "node:fs/promises";
import type { HostStopSender } from "./host-crash-record.ts";
import type { HostGenerationPaths } from "./host-daemon-paths.ts";
import { ageOf, readJsonObject, writeJsonAtomic } from "./host-state-json.ts";

/** An intent older than this describes some earlier stop, not the death being recorded now. */
export const STOP_INTENT_MAX_AGE_MS = 120_000;

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
