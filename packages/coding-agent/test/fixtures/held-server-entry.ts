import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";
import { runServerProcess } from "../../src/experimental/server.ts";

export const HELD_SERVER_READY_FILE = "held-server-ready";

// The real internal server entry, started only once the process receives SIGUSR2, so a test decides when a cold
// server begins listening (a slow cold start under load, made deterministic).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "server") throw new Error("Held server entry requires an internal server invocation");
	const args = process.argv.slice(2);
	const held = setInterval(() => {}, 60_000);
	process.once("SIGUSR2", () => {
		clearInterval(held);
		void runServerProcess(args).catch((error: unknown) => {
			console.error(error);
			process.exit(1);
		});
	});
	// SIGUSR2's default action ends the process, so the test signals only once this marker says the handler is in place.
	writeFileSync(join(args[0] ?? ".", HELD_SERVER_READY_FILE), "");
}
