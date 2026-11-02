// A minimal supervisor (senpi#3816 round 7): prepares this platform's lifetime binding the way the real supervisor does,
// spawns the host with its stdin key, holds every writer, and reports the host's pid once its binding is armed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { HOST_WATCH_LIFETIME_FIFO_ENV, prepareLifetimeBinding } from "../../src/modes/rpc/host-lifetime-binding.ts";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";

const [runtime = "node", hopDir = ""] = process.argv.slice(2);
const binding = prepareLifetimeBinding(hopDir);
const host = spawn(
	runtime,
	[
		...(runtime === "bun" ? [] : ["--import", "tsx"]),
		join(import.meta.dirname, "rpc-internal-lifetime-binding-host.ts"),
	],
	{
		env: {
			...hostSpawnEnv(),
			SENPI_RPC_INTERNAL_KEY_STDIN: "1",
			...(binding.lifetimeFifo === undefined ? {} : { [HOST_WATCH_LIFETIME_FIFO_ENV]: binding.lifetimeFifo }),
		},
		stdio: ["pipe", "pipe", "inherit"],
	},
);
host.stdin?.write(randomBytes(32));
let output = "";
host.stdout?.on("data", (chunk) => {
	output += String(chunk);
	if (output.includes("\n"))
		process.send?.({ host: host.pid, armed: output.trim(), fifo: binding.lifetimeFifo ?? null });
});
