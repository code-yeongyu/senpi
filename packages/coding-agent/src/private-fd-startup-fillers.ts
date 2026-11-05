/**
 * The startup pipe's filler slots (senpi#4602): which of slots 3..15 a private-descriptor spawn inherits, and
 * the release of the ones this process inherited. Side-effect free and never imports `private-fds.ts`: the
 * startup stub releases its fillers before that module adopts the table at import.
 */
import { closeSync } from "node:fs";
import { HOST_STARTUP_EVENTS_ENV } from "./modes/rpc/host-identity-env.ts";
import { encodeStartupHandOff, parseStartupHandOff, STARTUP_EVENT_FD } from "./modes/rpc/host-startup-wire.ts";
import { decodePrivateFdTable, PRIVATE_FDS_TABLE_ENV } from "./private-fd-table.ts";

/**
 * The spawn's stdio with the startup pipe at `STARTUP_EVENT_FD`, and the slots it had to fill on the way.
 *
 * Every unused slot from 3 to 15 becomes a FILLER pipe rather than "ignore": on macOS, Node's libuv `uv_spawn`
 * calls abort() - killing the spawning process, not the child - when a libuv-created pipe sits at a high slot
 * above an unfilled one and the parent has free descriptors below it (reproduced on Node 24 and 26, never on
 * Bun). Slots the spawn already uses, including the #4749 private descriptors `spawnWithPrivateFds` places at
 * their own numbers afterwards, are left alone. The child never reads a filler: no fd 3..15 is opened by number
 * without a flag naming it, and Node marks inherited descriptors close-on-exec, so they end with the child.
 * Pass the returned `fillers` to `releaseStartupFillers` right after the spawn.
 */
export function withStartupPipe<T>(base: readonly T[]): { readonly stdio: (T | "pipe")[]; readonly fillers: number[] } {
	const stdio: (T | "pipe")[] = [...base];
	const fillers: number[] = [];
	for (let slot = 3; slot < STARTUP_EVENT_FD; slot += 1) {
		const entry = stdio[slot];
		if (entry === undefined || entry === null || entry === "ignore") {
			stdio[slot] = "pipe";
			fillers.push(slot);
		}
	}
	stdio[STARTUP_EVENT_FD] = "pipe";
	return { stdio, fillers };
}

/** Closes the parent's end of every filler pipe; a slot a private descriptor took over has no stream. */
export function releaseStartupFillers(child: { readonly stdio: readonly unknown[] }, fillers: readonly number[]): void {
	for (const slot of fillers) {
		const stream = child.stdio[slot];
		if (typeof stream === "object" && stream !== null && "destroy" in stream && typeof stream.destroy === "function")
			stream.destroy();
	}
}

/** Every descriptor the table names, or undefined when a table is present but does not decode. */
function namedPrivateSlots(encoded: string | undefined): ReadonlySet<number> | undefined {
	const slots = new Set<number>();
	if (!encoded) return slots;
	const table = decodePrivateFdTable(encoded);
	if (!table.parsed) return undefined;
	for (const entry of table.values) for (const fd of [entry].flat()) if (typeof fd === "number") slots.add(fd);
	return slots;
}

/**
 * Closes the filler pipes this process inherited (they only kept libuv from aborting the spawn that created
 * them, see `withStartupPipe`) and removes their list from the hand-off, so a process this one re-executes or
 * spawns never closes a descriptor that is not a filler. A slot the #4749 private table names is that
 * channel's, never a filler, and stays open. A table that does not decode (the `unparseable` marker included)
 * cannot prove any slot free of a channel, so no filler is closed. Called first by every entry that can
 * receive a hand-off.
 */
export function releaseInheritedStartupFillers(env: NodeJS.ProcessEnv): void {
	const handOff = parseStartupHandOff(env[HOST_STARTUP_EVENTS_ENV]);
	if (!handOff?.fillers?.length) return;
	const privateSlots = namedPrivateSlots(env[PRIVATE_FDS_TABLE_ENV]);
	if (privateSlots) {
		for (const slot of handOff.fillers) {
			if (privateSlots.has(slot)) continue;
			try {
				closeSync(slot);
			} catch {
				// Already closed by an earlier entry of this same process: nothing left to release.
			}
		}
	}
	env[HOST_STARTUP_EVENTS_ENV] = encodeStartupHandOff({ ...handOff, fillers: [] });
}
