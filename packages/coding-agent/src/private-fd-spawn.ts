import type { ChildProcess, SpawnOptions, SpawnSyncOptions } from "node:child_process";
import { closeSync } from "node:fs";
import {
	PRIVATE_FDS_FINAL_ENV,
	type PrivateFdEntry,
	type PrivateFdForward,
	takePrivateDescriptors,
	UNPARSEABLE_TABLE,
} from "./private-fds.ts";

const TABLE_ENV = "SENPI_PRIVATE_FDS";

/**
 * Transfers the captured table only on explicit engine spawns, never via ambient child environments.
 * A shell cannot carry a descriptor, so it receives the name as a null declaration.
 * `final` marks the supervisor-to-engine hop: that engine claims its channels and forwards nothing.
 */
export function preparePrivateFdSpawn<T extends SpawnOptions | SpawnSyncOptions>(
	options: T,
	hop: { readonly final?: boolean } = {},
	forward: PrivateFdForward = takePrivateDescriptors(),
) {
	const env = { ...(options.env ?? process.env) };
	delete env[TABLE_ENV];
	delete env[PRIVATE_FDS_FINAL_ENV];
	const base = options.stdio ?? "pipe";
	const stdio = typeof base === "string" ? [base, base, base] : [...base];
	const owned: number[] = [];
	if (forward.kind === "unparseable") env[TABLE_ENV] = UNPARSEABLE_TABLE;
	else if (forward.entries.size > 0) {
		const carries = !options.shell;
		const table: Record<string, PrivateFdEntry> = {};
		for (const [name, fd] of forward.entries) {
			const descriptors = fd === null ? [] : typeof fd === "number" ? [fd] : fd;
			owned.push(...descriptors);
			if (fd !== null && carries) {
				for (const descriptor of descriptors) {
					while (stdio.length <= descriptor) stdio.push("ignore");
					stdio[descriptor] = descriptor;
				}
				table[name] = fd;
			} else {
				table[name] = null;
			}
		}
		env[TABLE_ENV] = JSON.stringify(table);
	}
	if (env[TABLE_ENV] !== undefined && hop.final) env[PRIVATE_FDS_FINAL_ENV] = "1";
	return {
		options: { ...options, env, stdio },
		close() {
			for (const fd of owned) closeSync(fd);
		},
	};
}

/**
 * Spawns through the caller's own `spawn` reference, so each call site keeps the instrumentation (and test
 * doubles) it had before descriptors were forwarded.
 */
export function spawnWithPrivateFds(
	spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
	command: string,
	args: readonly string[],
	options: SpawnOptions,
	hop: { readonly final?: boolean } = {},
): ChildProcess {
	const transfer = preparePrivateFdSpawn(options, hop);
	try {
		return spawn(command, args, transfer.options);
	} finally {
		transfer.close();
	}
}
