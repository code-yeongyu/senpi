import { closeSync, fstatSync } from "node:fs";
import type { Duplex } from "node:stream";
import { isMainThread } from "node:worker_threads";
import { inheritedDuplex } from "./utils/inherited-duplex.ts";
import { clearPrivateFdInherit } from "./utils/private-fd-inherit.ts";

const TABLE_ENV = "SENPI_PRIVATE_FDS";
/** Set only on the supervisor-to-engine hop: the engine claims its channels and never forwards them. */
export const PRIVATE_FDS_FINAL_ENV = "SENPI_PRIVATE_FDS_FINAL";
/** Forwarded in place of a table that was present but yielded no names, so every hop reads the same state. */
export const UNPARSEABLE_TABLE = "unparseable";
const STATE = Symbol.for("senpi.private-fds.v3");
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const QUOTED_NAME = /"([a-z][a-z0-9-]{0,63})"\s*:/g;

/** A name maps to a descriptor, or to null when the launcher declared it without a usable one. */
export type PrivateFdEntry = number | readonly [number, number] | null;

/**
 * Flip only after the Windows compiled-runtime proof and old-parser control pass at the pinned chain.
 * Every Bun bump invalidates this proof automatically; re-run both before recording the new version.
 */
export const WINDOWS_PRIVATE_FD_PAIR_PROVEN: { readonly bun: string } | false = false;

interface PrivateFdInspection {
	readonly platform: NodeJS.Platform;
	readonly bun: string | undefined;
	readonly proven: { readonly bun: string } | false;
	readonly ipc: number | null | undefined;
	readonly isSocket: (fd: number) => boolean;
	readonly isPipe: (fd: number) => boolean;
	readonly clearInherit: (fd: number) => boolean;
}

/** What the next engine hop receives: per-name entries, or the unparseable marker. */
export type PrivateFdForward =
	| { readonly kind: "entries"; readonly entries: ReadonlyMap<string, PrivateFdEntry> }
	| { readonly kind: "unparseable" };

interface PrivateFdState {
	readonly present: boolean;
	readonly declared: ReadonlySet<string>;
	readonly unparseable: boolean;
	readonly channels: Map<string, Exclude<PrivateFdEntry, null>>;
	readonly forward: Map<string, PrivateFdEntry>;
	forwardUnparseable: boolean;
}

function isState(value: unknown): value is PrivateFdState {
	return (
		typeof value === "object" &&
		value !== null &&
		"declared" in value &&
		value.declared instanceof Set &&
		"channels" in value &&
		value.channels instanceof Map &&
		"forward" in value &&
		value.forward instanceof Map
	);
}

/**
 * Measured on Node 24/26 and Bun 1.4 (macOS and Linux): each runtime marks inherited descriptors up to
 * at least 21 close-on-exec at startup, while Node on Linux leaks 24 and above into every child it
 * spawns. POSIX adopts only 5..15; Windows pairs instead clear inheritance explicitly at receipt.
 */
const ADOPTABLE_MAX = 15;

/**
 * The runtime's own IPC channel is an AF_UNIX socketpair too. Node names its descriptor; Bun exposes the
 * channel without one, so a Bun process with IPC adopts nothing (`undefined` = every descriptor refused).
 */
function ipcDescriptor(): number | null | undefined {
	const channel: unknown = Reflect.get(process, "channel");
	if (typeof channel !== "object" || channel === null) return null;
	const fd: unknown = Reflect.get(channel, "fd");
	return typeof fd === "number" ? fd : undefined;
}

function isSocket(fd: number): boolean {
	try {
		return fstatSync(fd).isSocket();
	} catch {
		return false;
	}
}

function isPipe(fd: number): boolean {
	try {
		return fstatSync(fd).isFIFO();
	} catch {
		return false;
	}
}

function inRange(fd: unknown): fd is number {
	return typeof fd === "number" && Number.isSafeInteger(fd) && fd >= 5 && fd <= 64;
}

/**
 * POSIX is socket-only: runtime-internal pipes (signal, async wakeup) are FIFOs and never adopted. A named socket
 * that cannot become a channel (above the protected range, or named twice) is closed so no child inherits it.
 */
function inspectEntry(
	fd: unknown,
	shared: boolean,
	runtime: PrivateFdInspection,
): { readonly channel: PrivateFdEntry; readonly discard: number | null } {
	const { ipc } = runtime;
	if (Array.isArray(fd)) {
		if (
			runtime.platform !== "win32" ||
			runtime.proven === false ||
			runtime.bun !== runtime.proven.bun ||
			fd.length !== 2 ||
			!inRange(fd[0]) ||
			!inRange(fd[1]) ||
			fd[0] === fd[1] ||
			shared ||
			ipc === undefined ||
			fd[0] === ipc ||
			fd[1] === ipc ||
			!runtime.isPipe(fd[0]) ||
			!runtime.isPipe(fd[1])
		)
			return { channel: null, discard: null };
		// No reads, writes or direction probes: only the type gate and receipt-time inherit clearing.
		const clearedRead = runtime.clearInherit(fd[0]);
		const clearedWrite = runtime.clearInherit(fd[1]);
		return { channel: clearedRead && clearedWrite ? [fd[0], fd[1]] : null, discard: null };
	}
	if (!inRange(fd)) return { channel: null, discard: null };
	if (runtime.platform === "win32" || ipc === undefined || fd === ipc || !runtime.isSocket(fd)) {
		return { channel: null, discard: null };
	}
	if (shared || fd > ADOPTABLE_MAX) return { channel: null, discard: fd };
	return { channel: fd, discard: null };
}

/**
 * A valid name is always declared. Only an unshared POSIX socket or a version-proven Windows pipe pair
 * becomes a channel. A table that does not parse declares the names it still quotes, without a channel.
 */
export function parseTable(
	encoded: string,
	inspection: Partial<PrivateFdInspection> = {},
): {
	readonly entries: Map<string, PrivateFdEntry>;
	readonly parsed: boolean;
	readonly discard: ReadonlySet<number>;
} {
	let value: unknown;
	try {
		value = encoded.length > 4096 ? undefined : JSON.parse(encoded);
	} catch {
		value = undefined;
	}
	const entries = new Map<string, PrivateFdEntry>();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		for (const match of encoded.slice(0, 4096).matchAll(QUOTED_NAME)) {
			const name = match[1];
			if (name !== undefined) entries.set(name, null);
		}
		return { entries, parsed: false, discard: new Set() };
	}
	const raw = Object.entries(value).filter(([name]) => NAME.test(name));
	const counts = new Map<number, number>();
	// Flatten even malformed entries: a bare number or a third pair element still aliases a handle.
	for (const fd of Object.values(value)) {
		for (const number of Array.isArray(fd) ? fd : [fd]) {
			if (typeof number === "number") counts.set(number, (counts.get(number) ?? 0) + 1);
		}
	}
	const runtime: PrivateFdInspection = {
		platform: process.platform,
		bun: process.versions.bun,
		proven: WINDOWS_PRIVATE_FD_PAIR_PROVEN,
		ipc: ipcDescriptor(),
		isSocket,
		isPipe,
		clearInherit: clearPrivateFdInherit,
		...inspection,
	};
	const discard = new Set<number>();
	for (const [name, fd] of raw) {
		// A descriptor named twice belongs to neither name.
		const numbers: unknown[] = Array.isArray(fd) ? fd : [fd];
		const shared = numbers.some((number) => typeof number === "number" && (counts.get(number) ?? 0) > 1);
		const entry = inspectEntry(fd, shared, runtime);
		entries.set(name, entry.channel);
		if (entry.discard !== null) discard.add(entry.discard);
	}
	return { entries, parsed: true, discard };
}

/** Read once, in the capturing main thread; session Workers never read a table. */
function capturedState(): PrivateFdState {
	const previous: unknown = Reflect.get(globalThis, STATE);
	if (isState(previous)) return previous;
	const encoded = isMainThread ? process.env[TABLE_ENV] : undefined;
	const final = isMainThread && process.env[PRIVATE_FDS_FINAL_ENV] === "1";
	if (isMainThread) {
		delete process.env[TABLE_ENV];
		delete process.env[PRIVATE_FDS_FINAL_ENV];
	}
	const { entries, parsed, discard } = encoded
		? parseTable(encoded)
		: { entries: new Map<string, PrivateFdEntry>(), parsed: true, discard: new Set<number>() };
	for (const fd of discard) closeSync(fd);
	const unparseable = !parsed && entries.size === 0;
	const state: PrivateFdState = {
		present: Boolean(encoded),
		declared: new Set(entries.keys()),
		unparseable,
		channels: new Map(),
		forward: new Map(),
		forwardUnparseable: unparseable && !final,
	};
	for (const [name, fd] of entries) {
		if (fd !== null) state.channels.set(name, fd);
		if (!final) state.forward.set(name, fd);
	}
	Reflect.set(globalThis, STATE, state);
	return state;
}

const state = capturedState();

/** True when the launcher declared this channel for the launch, with or without a usable descriptor. */
export function privateChannelDeclared(name: string): boolean {
	return state.declared.has(name);
}

/** True when this launch carried a table at all, even one that does not parse. */
export function privateTablePresent(): boolean {
	return state.present;
}

/** True when a table was present but no channel name could be read from it: declared, unavailable. */
export function privateFdTableUnparseable(): boolean {
	return state.unparseable;
}

/** Claim once. The caller owns disposal of the socket or both halves of the pipe pair. */
export function takeInheritedPrivateChannel(name: string): Duplex | undefined {
	const fd = state.channels.get(name);
	if (fd === undefined) return undefined;
	state.channels.delete(name);
	if (state.forward.has(name)) state.forward.set(name, null);
	return inheritedDuplex(fd);
}

/** Only the intentional next engine hop may take the table and descriptor ownership from this process. */
export function takePrivateDescriptors(): PrivateFdForward {
	if (state.forwardUnparseable) return { kind: "unparseable" };
	const entries = new Map(state.forward);
	// A later hop (an ensure retry) still declares every name; only the descriptors move, once.
	for (const [name, fd] of entries) {
		state.forward.set(name, null);
		if (fd !== null) state.channels.delete(name);
	}
	return { kind: "entries", entries };
}
