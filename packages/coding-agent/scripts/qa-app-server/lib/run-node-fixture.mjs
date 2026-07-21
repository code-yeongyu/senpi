#!/usr/bin/env node

const mode = process.argv[2];
if (!["cooperative", "resistant"].includes(mode)) throw new Error(`Unknown run-node fixture mode: ${mode ?? "missing"}`);
if (process.send === undefined) throw new Error("run-node fixture requires an IPC channel");

process.channel?.ref();
process.on("message", () => {});
process.once("SIGTERM", () => {
	process.send?.({ type: "term" }, (error) => {
		if (error) throw error;
		if (mode === "cooperative") process.exit(0);
	});
});
process.send({ type: "ready" });
