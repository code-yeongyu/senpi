import { spawn } from "node:child_process";
import { closeSync, createReadStream, writeSync } from "node:fs";
import { spawnHostChild } from "../../src/modes/rpc/host-lifecycle-launch.ts";

const mode = process.argv[2];

if (mode === "engine") {
	try {
		const input = createReadStream("", { fd: 5, autoClose: false });
		input.once("error", () => process.exit(2));
		input.once("data", (chunk) => {
			writeSync(5, `engine:${chunk.toString()}`);
			process.exit(0);
		});
	} catch {
		process.exit(2);
	}
} else if (mode === "supervisor") {
	const child = spawnHostChild({
		launch: {
			socket: "fixture",
			hostArgs: [],
			childCommand: process.execPath,
			childArgs: [import.meta.filename, "engine"],
		},
		internalSocket: "fixture",
		internal: { secretPath: "unused" },
		daemonDir: "unused",
		instanceId: "fixture",
		cleanupPaths: [],
		publicSocket: "fixture",
	});
	child.once("error", () => process.exit(3));
	child.once("exit", (code) => process.exit(code ?? 3));
} else if (mode === "unrelated") {
	const child = spawn(process.execPath, [import.meta.filename, "engine"], { stdio: "ignore" });
	child.once("exit", (code) => {
		writeSync(5, JSON.stringify({ childExit: code, leakedTable: process.env.SENPI_PRIVATE_FDS !== undefined }));
		closeSync(5);
	});
}
