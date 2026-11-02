// Parser control frozen from #4771 at e0877ef6e15af99d2c4d4ffafe53b22ec8875964.
// Re-run with every Bun bump before proving Windows pairs for that runtime.
import { fstatSync } from "node:fs";
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const QUOTED_NAME = /"([a-z][a-z0-9-]{0,63})"\s*:/g;
const ADOPTABLE_MAX = 15;
type PrivateFdEntry = number | null;
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
export function parseTable(encoded: string): {
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
