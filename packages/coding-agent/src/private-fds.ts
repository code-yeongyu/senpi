import { closeSync, fstatSync } from "node:fs";
import type { Duplex } from "node:stream";
import { inheritedDuplex } from "./utils/inherited-duplex.ts";

const TABLE_ENV = "SENPI_PRIVATE_FDS";
const STATE = Symbol.for("senpi.private-fds.v1");

/** Shared by the bundled CLI and the separately imported public subpath in the same isolate. */
function capturedChannels(): Map<string, number> {
	const previous: unknown = Reflect.get(globalThis, STATE);
	if (previous instanceof Map) return previous;
	const channels = new Map<string, number>();
	const encoded = process.env[TABLE_ENV];
	delete process.env[TABLE_ENV];
	Reflect.set(globalThis, STATE, channels);
	if (!encoded || encoded.length > 4096) return channels;
	try {
		const value: unknown = JSON.parse(encoded);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return channels;
		const entries = Object.entries(value);
		const descriptors = new Set<number>();
		for (const [name, fd] of entries) {
			if (
				!/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
				typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 5 || fd > 64 ||
				descriptors.has(fd)
			) return channels;
			descriptors.add(fd);
		}
		// Validate the entire table before adopting any handle. A missing entry never becomes another fd.
		for (const fd of descriptors) {
			const stat = fstatSync(fd);
			if (!stat.isSocket() && !stat.isFIFO()) return channels;
		}
		for (const [name, fd] of entries) {
			if (typeof fd === "number") {
				if (process.platform === "win32") closeSync(fd);
				else channels.set(name, fd);
			}
		}
	} catch {
		// Untrusted startup metadata is optional authority; never echo its contents.
		channels.clear();
	}
	return channels;
}

const channels = capturedChannels();

/** Claim once. The caller owns disposal; Windows handle adoption has a separate implementation. */
export function takeInheritedPrivateChannel(name: string): Duplex | undefined {
	const fd = channels.get(name);
	if (fd === undefined) return undefined;
	channels.delete(name);
	return inheritedDuplex(fd);
}

/** Only the intentional next engine hop may take descriptor ownership from this process. */
export function takePrivateDescriptors(): ReadonlyMap<string, number> {
	const taken = new Map(channels);
	channels.clear();
	return taken;
}
