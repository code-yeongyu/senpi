import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isServerId } from "@earendil-works/pi-protocol";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";
import { acquireServerProfile } from "../../src/experimental/server.ts";

export const HELD_LAUNCHER_READY_FILE = "held-launcher-ready";

// A server that takes its launcher lock and never starts listening: a startup that hangs while holding the lock.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (consumeInternalProcessRole() !== "server")
		throw new Error("Held launcher entry requires an internal server invocation");
	const [directory, serverId] = process.argv.slice(2);
	if (directory === undefined || serverId === undefined || !isServerId(serverId))
		throw new Error("Held launcher entry needs a directory and server id");
	setInterval(() => {}, 60_000);
	void acquireServerProfile(directory, serverId).then(() =>
		writeFileSync(join(directory, HELD_LAUNCHER_READY_FILE), ""),
	);
}
