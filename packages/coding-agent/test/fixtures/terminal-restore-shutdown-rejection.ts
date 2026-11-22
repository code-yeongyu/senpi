import { setImmediate } from "node:timers/promises";
import { ShutdownDiagnostics } from "../suite/terminal-restore-shutdown-diagnostics.ts";

const [phase, handled] = process.argv.slice(2);
const diagnostics = new ShutdownDiagnostics();
const generation = {};
diagnostics.register(generation);
const pending = Promise.withResolvers<void>();
const failure = new Error("shutdown rejection");
const sentinel = new Error("rejection pass complete");
const unhandled: unknown[] = [];
const reported = Promise.withResolvers<void>();
const onUnhandled = (reason: unknown) => {
	if (reason === sentinel) reported.resolve();
	else unhandled.push(reason);
};
// This is the same process event Vitest uses; isolate it so the expected error
// does not itself fail the owner file. Subscribe before triggering any rejection.
process.on("unhandledRejection", onUnhandled);
try {
	let observed!: Promise<void>;
	if (phase === "observe") {
		await diagnostics.shutdown(generation, () => {
			observed = diagnostics.observe("restore", () => pending.promise);
			return Promise.resolve();
		});
	} else {
		observed = diagnostics.shutdown(generation, () => pending.promise);
	}
	let caught = false;
	if (handled === "true")
		void observed.catch((error) => {
			caught = error === failure;
		});
	pending.reject(failure);
	// Node drains all rejection reactions before this event boundary. The next
	// unhandled sentinel closes the observation window without a timing delay.
	await setImmediate();
	void Promise.reject(sentinel);
	await reported.promise;
	const phases = diagnostics
		.snapshot([generation], "", [], "")
		.generations[0]?.phases.map(({ phase, status }) => ({ phase, status }));
	console.log(JSON.stringify({ unhandled: unhandled.map((reason) => reason === failure), caught, phases }));
} finally {
	process.off("unhandledRejection", onUnhandled);
}
