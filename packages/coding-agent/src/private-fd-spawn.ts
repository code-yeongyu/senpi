import childProcess, { type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { closeSync } from "node:fs";
import { takePrivateDescriptors } from "./private-fds.ts";

/** Transfers captured handles only on explicit engine spawns, never via ambient child environments. */
export function preparePrivateFdSpawn<T extends SpawnOptions | SpawnSyncOptions>(options: T) {
	const descriptors = takePrivateDescriptors();
	const env = { ...(options.env ?? process.env) };
	delete env.SENPI_PRIVATE_FDS;
	const base = options.stdio ?? "pipe";
	const stdio = typeof base === "string" ? [base, base, base] : [...base];
	if (!options.shell && descriptors.size > 0) {
		for (const fd of descriptors.values()) {
			while (stdio.length <= fd) stdio.push("ignore");
			stdio[fd] = fd;
		}
		env.SENPI_PRIVATE_FDS = JSON.stringify(Object.fromEntries(descriptors));
	}
	return {
		options: { ...options, env, stdio },
		close() {
			for (const fd of descriptors.values()) closeSync(fd);
		},
	};
}

export function spawnWithPrivateFds(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
	const transfer = preparePrivateFdSpawn(options);
	try {
		return childProcess.spawn(command, args, transfer.options);
	} finally {
		transfer.close();
	}
}
