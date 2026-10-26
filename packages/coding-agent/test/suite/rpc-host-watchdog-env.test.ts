import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { consumeHostWatchdogEnv } from "../../src/modes/rpc/host-watchdog.ts";

// senpi#3815 review L4: a host reads its supervisor binding once and removes it, so no tool, shell or nested host it
// starts inherits a binding to a supervisor that is not its own.
describe.skipIf(process.platform === "win32")("host watchdog environment", () => {
	it("is read once and removed, so a spawned child does not see it", () => {
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			SENPI_RPC_HOST_WATCH_PPID: String(process.pid),
			SENPI_RPC_HOST_WATCH_FD: "3",
			SENPI_RPC_HOST_WATCH_PSTART: "start",
			SENPI_RPC_HOST_WATCH_PSTART_TICKS: "42",
			SENPI_RPC_HOST_LIFETIME_FIFO: "/nonexistent/lifetime.fifo",
			SENPI_RPC_HOST_SCRATCH_DIR: "/nonexistent/scratch",
			SENPI_RPC_HOST_PUBLIC_SOCKET: "/nonexistent/rpc.sock",
			SENPI_RPC_HOST_CLEANUP_PATHS: "/nonexistent/a",
			SENPI_RPC_HOST_INSTANCE_ID: "instance",
			SENPI_RPC_HOST_DAEMON_DIR: "/nonexistent/daemon",
		};
		const config = consumeHostWatchdogEnv(env);
		expect(config).toMatchObject({ publicSocket: "/nonexistent/rpc.sock", scratchDir: "/nonexistent/scratch" });
		const seen = execFileSync(
			process.execPath,
			[
				"-e",
				"process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k.includes('RPC_HOST')).sort()))",
			],
			{ env, encoding: "utf8" },
		);
		// The generation identity stays: sessions use it to say which host they run in.
		expect(JSON.parse(seen)).toEqual(["SENPI_RPC_HOST_DAEMON_DIR", "SENPI_RPC_HOST_INSTANCE_ID"]);
	});
});
