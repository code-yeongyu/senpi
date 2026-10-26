import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { armHostWatchdog, readHostWatchdogConfigFromBrandEnv } from "../../src/modes/rpc/host-watchdog.ts";
import { readProcessStartTime } from "../../src/utils/process-identity.ts";

const [role, runtime, endpoint] = process.argv.slice(2);
const args = [...(runtime === "bun" ? [] : ["--import", "tsx"]), import.meta.filename];
if (role === "supervisor") {
	const child = spawn(runtime, [...args, "wrapper", runtime, endpoint], {
		env: {
			...process.env,
			SENPI_RPC_INTERNAL_KEY_STDIN: "1",
			SENPI_RPC_HOST_WATCH_PPID: String(process.pid),
			SENPI_RPC_HOST_WATCH_PSTART: await readProcessStartTime(process.pid),
			SENPI_RPC_HOST_WATCH_FD: "3",
		},
		stdio: ["pipe", "ignore", "inherit", "pipe"],
	});
	child.stdin?.on("error", () => {});
	child.stdin?.write(Buffer.alloc(32, 7));
} else if (role === "wrapper") {
	const child = spawn(runtime, [...args, "host", runtime, endpoint], { stdio: "inherit" });
	child.once("exit", (code) => process.exit(code ?? 1));
} else {
	// Only the engine consumes stdin, not a launcher that may re-exec it.
	const { getInternalHostBootstrap } = await import("../../src/modes/rpc/internal-bootstrap.ts");
	const bootstrap = getInternalHostBootstrap();
	if (!bootstrap) throw new Error("missing internal bootstrap");
	const config = readHostWatchdogConfigFromBrandEnv();
	armHostWatchdog({ ...config, lifetimeFd: bootstrap.lifetimeFd }, () => process.exit(0));
	const control = createConnection(endpoint);
	control.on("connect", () => control.write(JSON.stringify({ pid: process.pid, ppid: process.ppid })));
	control.on("data", () => control.write("alive"));
	control.on("error", () => process.exit(1));
}
