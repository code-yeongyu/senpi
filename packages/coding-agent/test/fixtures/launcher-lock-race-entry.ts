import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isServerId } from "@earendil-works/pi-protocol";
import { acquireServerProfile } from "../../src/experimental/server.ts";

// One process racing another for a launcher lock, round after round, so a race costs no process start-up. Each stdin
// line is a command: `acquire` takes the lock and prints ACQUIRED (or ERROR <code> if the acquire fails, so a refused
// takeover never passes for a wait); `release` releases the lock it holds and prints RELEASED; `exit` ends the process.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [directory, serverId] = process.argv.slice(2);
	if (directory === undefined || serverId === undefined || !isServerId(serverId))
		throw new Error("Launcher race entry needs a directory and server id");
	let held: { release(): Promise<void> } | undefined;
	for await (const command of createInterface({ input: process.stdin })) {
		if (command === "acquire") {
			try {
				held = await acquireServerProfile(directory, serverId);
				process.stdout.write("ACQUIRED\n");
			} catch (error) {
				process.stdout.write(
					`ERROR ${error instanceof Error && "code" in error ? String(error.code) : String(error)}\n`,
				);
			}
		} else if (command === "release") {
			await held?.release();
			held = undefined;
			process.stdout.write("RELEASED\n");
		} else if (command === "exit") {
			await held?.release();
			process.exit(0);
		}
	}
}
