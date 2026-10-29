import { closeSync, fstatSync } from "node:fs";
import type { Duplex } from "node:stream";
import { isMainThread } from "node:worker_threads";
import { inheritedDuplex } from "./utils/inherited-duplex.ts";

const TABLE_ENV = "SENPI_PRIVATE_FDS";
/** Set only on the supervisor-to-engine hop: the engine claims its channels and never forwards them. */
export const PRIVATE_FDS_FINAL_ENV = "SENPI_PRIVATE_FDS_FINAL";
/** Forwarded in place of a table that was present but yielded no names, so every hop reads the same state. */
export const UNPARSEABLE_TABLE = "unparseable";
const STATE = Symbol.for("senpi.private-fds.v3");
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const QUOTED_NAME = /"([a-z][a-z0-9-]{0,63})"\s*:/g;

/** A name maps to a descriptor, or to null when the launcher declared it without a usable one. */
export type PrivateFdEntry = number | null;

/** What the next engine hop receives: per-name entries, or the unparseable marker. */
export type PrivateFdForward =
	| { readonly kind: "entries"; readonly entries: ReadonlyMap<string, PrivateFdEntry> }
	| { readonly kind: "unparseable" };

interface PrivateFdState {
	readonly present: boolean;
	readonly declared: ReadonlySet<string>;
	readonly unparseable: boolean;
	readonly channels: Map<string, number>;
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
 * spawns. Only 5..15 is adopted, so an adopted or unclaimed channel never reaches an unrelated child.
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

/**
 * Socket-only: runtime-internal pipes (signal, async wakeup) are FIFOs and are never adopted. A named socket
 * that cannot become a channel (above the protected range, or named twice) is closed so no child inherits it.
 */
function inspectEntry(
	fd: unknown,
	shared: boolean,
	ipc: number | null | undefined,
): { readonly channel: number | null; readonly discard: number | null } {
	if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 5 || fd > 64)
		return { channel: null, discard: null };
	if (process.platform === "win32" || ipc === undefined || fd === ipc || !isSocket(fd)) {
		return { channel: null, discard: null };
	}
	if (shared || fd > ADOPTABLE_MAX) return { channel: null, discard: fd };
	return { channel: fd, discard: null };
}

/**
 * Per entry: a valid name is always declared; only a valid, open, unshared socket in range becomes a
 * channel. A table that does not parse declares the names it still quotes, all without a channel.
 */
function parseTable(encoded: string): {
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
	const counts = new Map<unknown, number>();
	for (const [, fd] of raw) counts.set(fd, (counts.get(fd) ?? 0) + 1);
	const ipc = ipcDescriptor();
	const discard = new Set<number>();
	for (const [name, fd] of raw) {
		// A descriptor named twice belongs to neither name.
		const entry = inspectEntry(fd, (counts.get(fd) ?? 0) > 1, ipc);
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

/** Claim once. The caller owns disposal; Windows handle adoption has a separate implementation. */
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
