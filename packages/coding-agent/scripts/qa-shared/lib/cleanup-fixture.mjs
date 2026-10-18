#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];

if (mode === "leaf") {
	process.on("SIGTERM", () => {});
	if (process.send === undefined) throw new Error("cleanup fixture leaf requires an IPC channel");
	process.send({ type: "ready" }, (error) => {
		if (error) throw error;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	});
} else if (mode === "leader") {
	const fixturePath = fileURLToPath(import.meta.url);
	const leaf = spawn(process.execPath, [fixturePath, "leaf"], {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	leaf.once("error", (error) => {
		process.stderr.write(`${error.stack ?? error.message}\n`);
		process.exit(1);
	});
	leaf.once("message", (message) => {
		if (message?.type !== "ready") return;
		process.stdout.write(`${JSON.stringify({ leaderPid: process.pid, leafPid: leaf.pid })}\n`);
	});
	process.once("SIGTERM", () => process.exit(0));
} else {
	throw new Error(`Unknown cleanup fixture mode: ${mode ?? "missing"}`);
}
