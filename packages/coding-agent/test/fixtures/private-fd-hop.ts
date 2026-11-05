import { spawn } from "node:child_process";
import { closeSync, createReadStream, fstatSync, writeSync } from "node:fs";
import { spawnHostChild } from "../../src/modes/rpc/host-lifecycle-launch.ts";
import { spawnWithPrivateFds } from "../../src/private-fd-spawn.ts";
import {
	privateChannelDeclared,
	privateFdTableUnparseable,
	privateTablePresent,
	takeInheritedPrivateChannel,
} from "../../src/private-fds.ts";

const mode = process.argv[2];

if (mode === "engine") {
	try {
		// Without a handed-over socket, fd 5 may be one of the runtime's own descriptors (Node opens one).
		if (!fstatSync(5).isSocket()) process.exit(2);
		const input = createReadStream("", { fd: 5, autoClose: false });
		input.once("error", () => process.exit(2));
		input.once("data", (chunk) => {
			writeSync(5, `engine:${chunk.toString()}`);
			process.exit(0);
		});
	} catch {
		process.exit(2);
	}
} else if (mode === "engine-report" || mode === "nested") {
	// Exit only after the claimed channel's write has flushed.
	const report = (code: number) => {
		const stream = takeInheritedPrivateChannel("sample-channel");
		const seen = {
			mode,
			present: privateTablePresent(),
			declared: privateChannelDeclared("sample-channel"),
			unparseable: privateFdTableUnparseable(),
			available: stream !== undefined,
		};
		writeSync(2, `${JSON.stringify(seen)}\n`);
		if (stream) stream.end("engine-claimed", () => process.exit(code));
		else process.exit(code);
	};
	if (mode === "nested") report(0);
	else {
		// Before the engine claims anything, a host it starts goes through the same helper as ensure.
		const nested = spawnWithPrivateFds(spawn, process.execPath, [import.meta.filename, "nested"], {
			env: process.env,
			stdio: ["ignore", "ignore", "inherit"],
		});
		nested.once("exit", (code) => report(code ?? 3));
	}
} else if (mode === "receiver") {
	const stream = takeInheritedPrivateChannel("sample-channel");
	const again = takeInheritedPrivateChannel("sample-channel");
	writeSync(
		1,
		JSON.stringify({
			available: stream !== undefined,
			repeated: again !== undefined,
			declared: privateChannelDeclared("sample-channel"),
			present: privateTablePresent(),
			unparseable: privateFdTableUnparseable(),
		}),
	);
	if (stream) {
		stream.once("data", (chunk) => {
			stream.end(`claimed:${chunk.toString()}`, () => stream.destroy());
		});
	}
} else if (mode === "supervisor" || mode === "supervisor-report") {
	const child = spawnHostChild({
		launch: {
			socket: "fixture",
			hostArgs: [],
			childCommand: process.execPath,
			childArgs: [import.meta.filename, mode === "supervisor" ? "engine" : "engine-report"],
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
