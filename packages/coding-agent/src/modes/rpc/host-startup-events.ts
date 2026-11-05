/**
 * The launcher's side of the startup-event records (senpi#4602, A-amended section 1). A record proves
 * nothing by itself: the controller binds each producer role to its own stream before spawning, so `role`
 * here must match the stream it arrived on, and the attempt nonce must match the attempt the controller
 * allocated.
 */
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { StartupController } from "./host-startup-policy.ts";
import {
	MAX_STARTUP_EVENT_BYTES,
	STARTUP_EVENT_PROTOCOL_VERSION,
	type StartupBinding,
	type StartupMilestone,
	type StartupProducerRole,
} from "./host-startup-wire.ts";

const MAX_STARTUP_EVENTS_PER_PRODUCER = 32;

/** The only role allowed to report each milestone; the controller completes the remaining phases itself. */
const STARTUP_MILESTONE_PRODUCER: Readonly<Partial<Record<StartupMilestone, StartupProducerRole>>> = {
	supervisor_bootstrap: "supervisor",
	supervisor_setup: "supervisor",
	host_opaque: "supervisor",
	host_bootstrap: "host",
	host_runtime: "host",
	internal_ready: "supervisor",
	observer_ready: "supervisor",
	public_published: "supervisor",
};

export function newStartupAttempt(): string {
	return randomBytes(16).toString("hex");
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
		if (!isProducerMilestone(milestone)) return failProtocol(`unknown milestone ${String(milestone)}`);
		if (STARTUP_MILESTONE_PRODUCER[milestone] !== role) return failProtocol(`${role} cannot report ${milestone}`);
		const verdict = milestone === "host_opaque" ? controller.declareOpaqueHost() : controller.complete(milestone);
		if (verdict !== "rejected") return verdict;
		if (controller.terminal) return "ignored";
		return failProtocol(`${milestone} reported before its phase was granted`);
	};
}

/**
 * Reads the supervisor's startup pipe: its own records go to the supervisor ingress, relayed host-child
 * records to the host ingress. A line that outgrows a relay frame of the record limit fails the attempt.
 */
export function attachStartupEvents(stream: Readable, controller: StartupController, binding: StartupBinding): void {
	const supervisor = startupEventIngress(controller, binding, "supervisor");
	const host = startupEventIngress(controller, binding, "host");
	const maxLine = 2 * MAX_STARTUP_EVENT_BYTES + 64;
	let pending = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		if (controller.terminal) return;
		pending += chunk;
		for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			const relayed = unwrapStartupRelay(line);
			if (relayed === undefined) supervisor(line);
			else host(relayed);
			if (controller.terminal) return;
		}
		if (pending.length > maxLine) supervisor(pending);
	});
	// The supervisor holds its end for life: the launcher's end must never keep the caller's process alive. It is
	// never destroyed here - the ChildProcess closes its own stdio when the supervisor exits - and a settled
	// attempt only drains and ignores what arrives.
	stream.on("error", () => {});
	if ("unref" in stream && typeof stream.unref === "function") stream.unref();
}

/** The host-child record a relay frame carries, or undefined for the supervisor's own records. */
function unwrapStartupRelay(line: string): string | undefined {
	if (!line.startsWith('{"relay":')) return undefined;
	try {
		const frame: unknown = JSON.parse(line);
		if (typeof frame !== "object" || frame === null) return undefined;
		const { relay, line: inner } = frame as Record<string, unknown>;
		return relay === "host" && typeof inner === "string" ? inner : undefined;
	} catch {
		return undefined;
	}
}

type RawRecord = { binding: unknown; role: unknown; seq: number; milestone: unknown };

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
	return { binding: record.binding, role: record.role, seq: record.seq, milestone: record.milestone };
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

function isProducerMilestone(value: unknown): value is StartupMilestone {
	return typeof value === "string" && Object.hasOwn(STARTUP_MILESTONE_PRODUCER, value);
}
