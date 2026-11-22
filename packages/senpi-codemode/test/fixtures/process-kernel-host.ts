// A host process that owns one process-mode kernel and never closes it: it prints the kernel child's pid, then waits
// for the test to end it (SIGKILL, or a plain exit when it is sent "exit"). With "busy", a cell that never yields is
// running when the host is ended.
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

const kernel = new JavaScriptKernel({
	sessionId: `host-${process.pid}`,
	cwd: process.cwd(),
	parallelPoolWidth: 1,
	isolation: "process",
});
await kernel.run({ cellId: "host-cell", code: "globalThis.alive = true", timeoutMs: 20_000 });
if (process.argv.includes("busy")) {
	// The cell says it is spinning before it starts; its output reaches the host even while it spins, so the host reports
	// its child only once the cell is blocking the child's main thread.
	const spinning = Promise.withResolvers<void>();
	void kernel.run({
		cellId: "host-busy",
		code: 'console.log("spinning"); for (;;) {}',
		timeoutMs: 600_000,
		onMessage: (message) => {
			if (message.type === "text" && message.data.includes("spinning")) spinning.resolve();
		},
	});
	await spinning.promise;
}
process.stdout.write(`child ${kernel.processPid}\n`);
process.stdin.on("data", (data) => {
	if (String(data).includes("exit")) process.exit(0);
});
