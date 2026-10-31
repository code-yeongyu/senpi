/**
 * The startup stub of a coordinated launch (senpi#4602, A-amended section 2). Imported FIRST by every
 * supervisor and host-child entry, so its bootstrap milestone is written before the entry's lifecycle or
 * application graph is evaluated. It consumes its hand-off variable at load, so nothing this process
 * spawns later inherits it; without the variable, or without a pipe at the startup descriptor, it is inert.
 */
import { fstatSync, writeSync } from "node:fs";
import type { Readable } from "node:stream";
import { isMainThread } from "node:worker_threads";
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

const STATE = Symbol.for("senpi.startup-beacon.v1");

interface BeaconState {
	readonly handOff: StartupHandOff;
	seq: number;
	open: boolean;
}

function isStartupPipe(fd: number): boolean {
	try {
		const stat = fstatSync(fd);
		return stat.isFIFO() || stat.isSocket();
	} catch {
		return false;
	}
}

function captured(): BeaconState | null {
	const previous: unknown = Reflect.get(globalThis, STATE);
	if (previous !== undefined) return previous as BeaconState | null;
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

/** The hand-off this process reports for, when it is a coordinated producer. */
export function startupHandOff(): StartupHandOff | undefined {
	return state?.handOff;
}

export function reportStartupMilestone(milestone: StartupMilestone): void {
	if (state) write(state, startupEventLine(state.handOff.binding, state.handOff.role, ++state.seq, milestone));
}

/** The environment value for the host child a coordinated supervisor spawns, or undefined when uncoordinated. */
export function hostChildStartupHandOff(): string | undefined {
	return state ? encodeStartupHandOff({ ...state.handOff, role: "host" }) : undefined;
}

/**
 * The supervisor relays its host child's startup pipe verbatim inside relay frames. It never writes a host
 * milestone itself; a line over the record limit is forwarded truncated, so the launcher rejects it.
 */
export function relayHostStartupEvents(stream: Readable | null | undefined): void {
	if (!state || !stream) {
		stream?.resume();
		return;
	}
	let pending = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		pending += chunk;
		for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
			write(state, relayStartupLine(pending.slice(0, newline)));
			pending = pending.slice(newline + 1);
		}
		if (pending.length > MAX_STARTUP_EVENT_BYTES) {
			write(state, relayStartupLine(pending.slice(0, MAX_STARTUP_EVENT_BYTES + 1)));
			pending = "";
		}
	});
	stream.on("error", () => {});
}
