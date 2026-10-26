import { spawn } from "node:child_process";
import { fstatSync, statSync } from "node:fs";
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
	}),
);
process.on("message", () => process.exit(0));
