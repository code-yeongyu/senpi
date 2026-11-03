/**
 * The startup stub of a coordinated launch (senpi#4602, A-amended section 2). Every supervisor and host-child
 * entry imports it before the private descriptor table (`private-fds.ts`) and its lifecycle or application
 * graph, after only the entry's own environment guard (`valid-cwd` in cli-main, `sandbox-env-setup` in
 * bun/cli), so its bootstrap milestone is written before that graph is evaluated and its fillers are released
 * before the table is adopted. It consumes its hand-off variable at load, so nothing this process
 * spawns later inherits it; without the variable, or without a pipe at the startup descriptor, it is inert.
 */
import { fstatSync, writeSync } from "node:fs";
import type { Readable } from "node:stream";
import { isMainThread } from "node:worker_threads";
import { isFifoMode } from "../../utils/inherited-duplex.ts";
import { HOST_STARTUP_EVENTS_ENV } from "./host-identity-env.ts";
import {
	encodeStartupHandOff,
	MAX_STARTUP_EVENT_BYTES,
	parseStartupHandOff,
	relayStartupLine,
	STARTUP_EVENT_FD,
	type StartupHandOff,
	type StartupMilestone,
	startupEventLine,
} from "./host-startup-wire.ts";
import { releaseInheritedStartupFillers } from "../../private-fd-startup-fillers.ts";

const STATE = Symbol.for("senpi.startup-beacon.v1");

interface BeaconState {
	readonly handOff: StartupHandOff;
	seq: number;
	open: boolean;
}

function isStartupPipe(fd: number): boolean {
	try {
		const stat = fstatSync(fd);
		// Windows can report FIFO mode bits while Stats.isFIFO() returns false (#5137).
		return isFifoMode(stat.mode) || stat.isSocket();
	} catch {
		return false;
	}
}

function captured(): BeaconState | null {
	const previous: unknown = Reflect.get(globalThis, STATE);
	if (previous !== undefined) return previous as BeaconState | null;
	if (isMainThread) releaseInheritedStartupFillers(process.env);
	const handOff = isMainThread ? parseStartupHandOff(process.env[HOST_STARTUP_EVENTS_ENV]) : undefined;
	if (isMainThread) delete process.env[HOST_STARTUP_EVENTS_ENV];
	const state = handOff && isStartupPipe(STARTUP_EVENT_FD) ? { handOff, seq: 0, open: true } : null;
	Reflect.set(globalThis, STATE, state);
	if (state)
		write(state, startupEventLine(state.handOff.binding, state.handOff.role, ++state.seq, bootstrapOf(state)));
	return state;
}

function bootstrapOf(state: BeaconState): StartupMilestone {
	return state.handOff.role === "supervisor" ? "supervisor_bootstrap" : "host_bootstrap";
}

/** A lost pipe only stops reporting: the launcher's phase deadlines decide what that means. */
function write(state: BeaconState, line: string): void {
	if (!state.open) return;
	try {
		writeSync(STARTUP_EVENT_FD, line);
	} catch {
		state.open = false;
	}
}

const state = captured();
const reporter = state ? startupReporter((line) => write(state, line)) : undefined;

/**
 * The supervisor's one writer to its startup pipe. Its own milestones and its host child's relayed records come from
 * two processes, so nothing about the pipes orders them: on Windows the supervisor's internal probe can connect before
 * the relay has read the host's `host_runtime`. The launcher's phase order is kept here instead - no host record is
 * forwarded before `supervisor_setup`, and `internal_ready`, with everything after it, waits for the relayed
 * `host_runtime`. A relay that ends first releases what it held, so the launcher still decides.
 */
export function startupReporter(emit: (line: string) => void) {
	let relaying = false;
	let relayEnded = false;
	let setupSent = false;
	let runtimeRelayed = false;
	const heldOwn: string[] = [];
	const heldHost: string[] = [];
	const waitingForHost = (): boolean => relaying && !relayEnded && !runtimeRelayed;
	const releaseOwn = (): void => {
		if (!waitingForHost()) for (const line of heldOwn.splice(0)) emit(line);
	};
	const forwardHost = (record: string): void => {
		emit(relayStartupLine(record));
		if (recordMilestone(record) === "host_runtime") runtimeRelayed = true;
		releaseOwn();
	};
	return {
		report(line: string, milestone: StartupMilestone): void {
			if (heldOwn.length > 0 || (milestone === "internal_ready" && waitingForHost())) {
				heldOwn.push(line);
				return;
			}
			emit(line);
			if (milestone !== "supervisor_setup") return;
			setupSent = true;
			for (const record of heldHost.splice(0)) forwardHost(record);
		},
		/** A line over the record limit is forwarded truncated, so the launcher rejects it. */
		relay(stream: Readable): void {
			relaying = true;
			const forward = (record: string): void => {
				if (setupSent) forwardHost(record);
				else heldHost.push(record);
			};
			const ended = (): void => {
				relayEnded = true;
				releaseOwn();
			};
			let pending = "";
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				pending += chunk;
				for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
					forward(pending.slice(0, newline));
					pending = pending.slice(newline + 1);
				}
				if (pending.length > MAX_STARTUP_EVENT_BYTES) {
					forward(pending.slice(0, MAX_STARTUP_EVENT_BYTES + 1));
					pending = "";
				}
			});
			stream.on("end", ended);
			stream.on("close", ended);
			stream.on("error", ended);
		},
	};
}

/** Ordering only: the launcher validates every relayed record itself. */
function recordMilestone(record: string): unknown {
	try {
		const value: unknown = JSON.parse(record);
		return typeof value === "object" && value !== null ? Reflect.get(value, "milestone") : undefined;
	} catch {
		return undefined;
	}
}

/** The hand-off this process reports for, when it is a coordinated producer. */
export function startupHandOff(): StartupHandOff | undefined {
	return state?.handOff;
}

export function reportStartupMilestone(milestone: StartupMilestone): void {
	if (state && reporter)
		reporter.report(startupEventLine(state.handOff.binding, state.handOff.role, ++state.seq, milestone), milestone);
}

/** The environment value for the host child a coordinated supervisor spawns, or undefined when uncoordinated. */
export function hostChildStartupHandOff(fillers: readonly number[]): string | undefined {
	return state ? encodeStartupHandOff({ ...state.handOff, role: "host", fillers }) : undefined;
}

/** The supervisor relays its host child's startup pipe verbatim inside relay frames; it never writes a host milestone itself. */
export function relayHostStartupEvents(stream: Readable | null | undefined): void {
	if (!reporter || !stream) {
		stream?.resume();
		return;
	}
	reporter.relay(stream);
}
