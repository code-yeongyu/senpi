/**
 * The private startup-event records a host attempt's producers send its startup controller
 * (senpi#4602, A-amended section 1). A record proves nothing by itself: the controller binds each
 * producer role to its own pipe before spawning, so `role` here must match the stream it arrived
 * on, and the attempt nonce must match the attempt the controller allocated.
 */
import { randomBytes } from "node:crypto";
import type { StartupController, StartupPhase } from "./host-startup-policy.ts";

const STARTUP_EVENT_PROTOCOL_VERSION = 1;
export const MAX_STARTUP_EVENT_BYTES = 4096;
const MAX_STARTUP_EVENTS_PER_PRODUCER = 32;

export type StartupProducerRole = "supervisor" | "host";

export interface StartupBinding {
	readonly attempt: string;
	readonly endpoint: string;
	readonly instanceId: string;
	readonly generation: number;
	readonly launchKind: "initial" | "successor";
	readonly predecessor: string | null;
}

/** The only role allowed to complete each producer-reported phase; the controller completes the rest itself. */
const STARTUP_PHASE_PRODUCER: Readonly<Partial<Record<StartupPhase, StartupProducerRole>>> = {
	supervisor_bootstrap: "supervisor",
	supervisor_setup: "supervisor",
	host_bootstrap: "host",
	host_runtime: "host",
	internal_ready: "supervisor",
	observer_ready: "supervisor",
	public_published: "supervisor",
};

export function newStartupAttempt(): string {
	return randomBytes(16).toString("hex");
}

export function startupEventLine(
	binding: StartupBinding,
	role: StartupProducerRole,
	seq: number,
	milestone: StartupPhase,
) {
	return `${JSON.stringify({ v: STARTUP_EVENT_PROTOCOL_VERSION, binding, role, seq, milestone })}\n`;
}

export type StartupIngressResult = "accepted" | "ignored" | "discarded" | "protocol_failure";

/**
 * Feeds one producer stream's records into the controller. Wrong-attempt records are discarded
 * without renewing anything; duplicate sequence numbers are ignored; an unknown milestone, a record
 * for a phase another role owns, a sequence gap or an over-limit record fails the attempt.
 */
export function startupEventIngress(controller: StartupController, binding: StartupBinding, role: StartupProducerRole) {
	let lastSeq = 0;
	let records = 0;
	const failProtocol = (reason: string): StartupIngressResult => {
		controller.fail(new Error(`RPC host startup protocol failure (${role}): ${reason}`));
		return "protocol_failure";
	};
	return (line: string): StartupIngressResult => {
		if (Buffer.byteLength(line, "utf8") > MAX_STARTUP_EVENT_BYTES) return failProtocol("record exceeds 4096 bytes");
		const record = parseRecord(line);
		if (!record) return failProtocol("malformed record");
		if (!sameBinding(record.binding, binding)) return "discarded";
		if (record.role !== role) return failProtocol(`record claims role ${String(record.role)}`);
		if (record.seq <= lastSeq) return "ignored";
		if (record.seq !== lastSeq + 1) return failProtocol(`sequence gap after ${lastSeq}`);
		records += 1;
		if (records > MAX_STARTUP_EVENTS_PER_PRODUCER) return failProtocol("too many records");
		lastSeq = record.seq;
		const milestone = record.milestone;
		if (!isProducerPhase(milestone)) return failProtocol(`unknown milestone ${String(milestone)}`);
		if (STARTUP_PHASE_PRODUCER[milestone] !== role) return failProtocol(`${role} cannot report ${milestone}`);
		const verdict = controller.complete(milestone);
		if (verdict !== "rejected") return verdict;
		if (controller.terminal) return "ignored";
		return failProtocol(`${milestone} reported before its phase was granted`);
	};
}

type RawRecord = { v: unknown; binding: unknown; role: unknown; seq: number; milestone: unknown };

function parseRecord(line: string): RawRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.v !== STARTUP_EVENT_PROTOCOL_VERSION) return undefined;
	if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 1) return undefined;
	return { v: record.v, binding: record.binding, role: record.role, seq: record.seq, milestone: record.milestone };
}

function sameBinding(candidate: unknown, binding: StartupBinding): boolean {
	if (typeof candidate !== "object" || candidate === null) return false;
	const other = candidate as Record<string, unknown>;
	return (
		other.attempt === binding.attempt &&
		other.endpoint === binding.endpoint &&
		other.instanceId === binding.instanceId &&
		other.generation === binding.generation &&
		other.launchKind === binding.launchKind &&
		other.predecessor === binding.predecessor
	);
}

function isProducerPhase(value: unknown): value is StartupPhase {
	return typeof value === "string" && Object.hasOwn(STARTUP_PHASE_PRODUCER, value);
}
