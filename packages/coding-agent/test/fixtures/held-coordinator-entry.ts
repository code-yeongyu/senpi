import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoordinatorProcess } from "../../src/experimental/coordinator.ts";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";

export const HELD_COORDINATOR_READY_FILE = "held-coordinator-ready";

// The real coordinator entry, started only once the process receives SIGUSR2, so a test decides when a coordinator
// begins accepting (a slow cold start under load, made deterministic).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "coordinator") throw new Error("Held coordinator entry requires an internal coordinator invocation");
	const args = process.argv.slice(2);
	const held = setInterval(() => {}, 60_000);
	process.once("SIGUSR2", () => {
		clearInterval(held);
		void runCoordinatorProcess(args).catch((error: unknown) => {
			console.error(error);
			process.exit(1);
		});
	});
	// SIGUSR2's default action ends the process, so the test signals only once this marker says the handler is in place.
	writeFileSync(join(dirname(args[1] ?? "."), HELD_COORDINATOR_READY_FILE), "");
}
