import { spawn } from "node:child_process";
import { fstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { armHostWatchdog } from "../../src/modes/rpc/host-watchdog.ts";

if (process.argv[2] === "fail-reopen") {
	const fs = createRequire(import.meta.url)("node:fs");
	const open = fs.openSync;
	fs.openSync = (path: string, ...args: unknown[]) => {
		if (path === "/dev/fd/0") throw Object.assign(new Error("unavailable"), { code: process.argv[3] });
		return open(path, ...args);
	};
	syncBuiltinESMExports();
}
// senpi#4528: while fd 0 is free (between the bootstrap's close and its /dev/null open), wait, bounded, for a new
// compile-cache entry. Only an exiting thread flushes that cache, and the one thread that can exit here is the key
// deadline worker, so a new entry means the worker was released, and could take the free fd 0, before the restore.
// The bound stays well inside the worker's 2 s key deadline, which runs until the worker is released.
let workerIoWhileStdinFree: boolean | undefined;
if (process.argv[2] === "await-worker-io") {
	const fs = createRequire(import.meta.url)("node:fs");
	const cacheDir = process.env.NODE_COMPILE_CACHE;
	if (!cacheDir) throw new Error("await-worker-io needs NODE_COMPILE_CACHE");
	const entries = (): string[] =>
		fs.readdirSync(cacheDir, { recursive: true }).map((entry: string) => join(cacheDir, entry));
	const open = fs.openSync;
	fs.openSync = (path: string, ...args: unknown[]) => {
		if (path === "/dev/null" && workerIoWhileStdinFree === undefined) {
			const before = new Set(entries());
			const pause = new Int32Array(new SharedArrayBuffer(4));
			const until = Date.now() + 600;
			workerIoWhileStdinFree = false;
			while (!workerIoWhileStdinFree && Date.now() < until) {
				workerIoWhileStdinFree = entries().some((entry) => !before.has(entry));
				if (!workerIoWhileStdinFree) Atomics.wait(pause, 0, 0, 5);
			}
		}
		return open(path, ...args);
	};
	syncBuiltinESMExports();
}
// Dynamic import intentionally follows the injected OS failure, before stdin is touched.
const { getInternalHostBootstrap } = await import("../../src/modes/rpc/internal-bootstrap.ts");
const bootstrap = getInternalHostBootstrap();
if (!bootstrap) throw new Error("bootstrap not selected");
armHostWatchdog({ lifetimeFd: bootstrap.lifetimeFd }, () => {
	process.send?.({ type: "eof" });
	process.exit(0);
});
const stdinNull = fstatSync(0).isCharacterDevice() && fstatSync(0).rdev === statSync("/dev/null").rdev;
const cat = spawn("cat", [], { stdio: ["inherit", "ignore", "inherit"] });
cat.once("exit", (code) =>
	process.send?.({
		type: "ready",
		key: bootstrap.key.toString("hex"),
		stdinNull,
		catCode: code,
		lifetime: bootstrap.lifetimeFd !== undefined,
		...(workerIoWhileStdinFree === undefined ? {} : { workerIoWhileStdinFree }),
	}),
);
process.on("message", () => process.exit(0));
