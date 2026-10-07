import { createServer, type Socket } from "node:net";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { withTimeout } from "../src/kernels/py/process.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { executeEvalControl } from "../src/tool/detached-eval-result.ts";

class QaShellReadinessError extends Error {
	readonly code = "qa_shell_ready_failed";
}

const connected = Promise.withResolvers<void>();
const disconnected = Promise.withResolvers<void>();
const sockets = new Set<Socket>();
const server = createServer((socket) => {
	sockets.add(socket);
	socket.once("close", () => disconnected.resolve());
	connected.resolve();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Missing listener address");
const mode = process.argv[2] ?? "shell";
const kernel = new JavaScriptKernel({
	sessionId: "shell-stop-qa",
	cwd: process.cwd(),
	parallelPoolWidth: 1,
	interruptBounds: { ackMs: 20_000, graceMs: 50, terminateDeadlineMs: 20_000 },
});
const manager = new EvalDetachedCellManager();
const childCode = `const socket = Bun.connect({hostname:"127.0.0.1",port:${address.port},socket:{data(){},open(){},close(){}}}); await socket; await new Promise(()=>{});`;
try {
	if (mode === "normal" || mode === "finished") {
		const completed = await kernel.run({
			cellId: "complete-shell",
			code: 'globalThis.saved = 41; return await Bun.$`echo normal`.text();',
			timeoutMs: 60_000,
		});
		if (mode === "finished") {
			const next = await kernel.run({ cellId: "after", code: "return globalThis.saved", timeoutMs: 60_000 });
			console.log(JSON.stringify({ completed, next }));
		} else {
			const called = kernel.nextToolCall();
			const run = kernel.run({ cellId: "normal-wait", code: "await tool.ready({});", timeoutMs: 60_000 });
			await withTimeout(called, 30_000, "Host-tool readiness event did not arrive");
			const handle = await kernel.interrupt("stop", "normal-wait");
			const result = await run;
			const next = await kernel.run({ cellId: "after", code: "return globalThis.saved", timeoutMs: 60_000 });
			console.log(JSON.stringify({ result, retained: await handle.stateRetained, note: handle.note, next }));
		}
	} else if (mode === "late") {
		// #2788: Stop releases the cell while it awaits a host tool, so the shell it would start after swallowing the
		// interruption is refused instead of running and costing the worker.
		const shell = `Bun.$\`\${${JSON.stringify(process.execPath)}} -e \${${JSON.stringify(childCode)}}\``;
		const called = kernel.nextToolCall();
		const run = kernel.run({
			cellId: "late-stop",
			code: `globalThis.saved = 41; try { await tool.ready({}); } catch {} try { await ${shell}; } catch (error) { globalThis.lateShell = String(error.message); }`,
			timeoutMs: 60_000,
		});
		await withTimeout(called, 30_000, "Host-tool readiness event did not arrive");
		const handle = await kernel.interrupt("stop", "late-stop");
		const result = await run;
		const next = await kernel.run({
			cellId: "after",
			code: "return { saved: globalThis.saved, lateShell: globalThis.lateShell }",
			timeoutMs: 60_000,
		});
		console.log(JSON.stringify({ result, retained: await handle.stateRetained, next }));
	} else {
	const shell = `Bun.$\`\${${JSON.stringify(process.execPath)}} -e \${${JSON.stringify(childCode)}}\``;
	const expression = mode === "failed" ? "await Bun.$`exit 7`;"
		: mode === "lines" ? `for await (const line of ${shell}.lines()) { print(line); }`
		: mode === "text" ? `await ${shell}.text();`
		: `await ${shell};`;
	const code = `globalThis.saved = 41; ${expression}`;
	const managed = manager.create("shell-stop", { language: "js", code, summary: "Verify shell Stop outcome" });
	manager.bindKernel(managed, kernel, () => ({
		content: [],
		details: { language: "js", durationMs: 0, toolCalls: [], truncated: false },
	}));
	if (!manager.detach(managed)) throw new Error("Shell cell did not detach");
	const run = kernel.run({
		cellId: "shell-stop",
		code,
		onStarted: () => manager.markRunning(managed),
		timeoutMs: 60_000,
	});
	const prematureExit = run.then(() => {
		throw new QaShellReadinessError("Shell command ended before connection");
	});
	await withTimeout(Promise.race([connected.promise, prematureExit]), 30_000, "Command readiness event did not arrive");
	const stopping = executeEvalControl(manager, { action: "stop", cell_id: "shell-stop" });
	await withTimeout(Promise.race([connected.promise, prematureExit]), 30_000, "Command readiness event did not arrive");
	const control = await stopping;
	const snapshot = manager.peek("shell-stop");
	const result = await run;
	const next = await kernel.run({ cellId: "after", code: "return globalThis.saved", timeoutMs: 60_000 });
	console.log(JSON.stringify({ result, retained: snapshot.stateRetained, note: snapshot.interruptNote, control, next }));
	await withTimeout(disconnected.promise, 10_000, "Shell command survived Stop");
	console.log("COMMAND_EXITED");
	}
} catch (error) {
	if (!(error instanceof QaShellReadinessError)) throw error;
	console.error(JSON.stringify({ code: error.code }));
	process.exitCode = 1;
} finally {
	await manager.dispose();
	await kernel.close();
	for (const socket of sockets) socket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	console.log("CLEANUP_COMPLETE");
}
