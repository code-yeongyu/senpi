import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { internalHostTransport } from "../../src/modes/rpc/host-internal-transport.ts";
import { HOST_WATCH_LIFETIME_FIFO_ENV, readHostWatchdogConfigFromBrandEnv } from "../../src/modes/rpc/host-watchdog.ts";

const saved = { fifo: process.env[HOST_WATCH_LIFETIME_FIFO_ENV], ppid: process.env.SENPI_RPC_HOST_WATCH_PPID };
afterEach(() => {
	for (const [name, value] of [
		[HOST_WATCH_LIFETIME_FIFO_ENV, saved.fifo],
		["SENPI_RPC_HOST_WATCH_PPID", saved.ppid],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

// senpi#3816 review (L4): the lifetime FIFO path is the host's alone. Once the host has read it, processes the host runs
// (tools, bash) must not inherit it, or a same-user process could open the FIFO for writing and hold off shutdown.
describe.skipIf(process.platform === "win32")("lifetime FIFO environment", () => {
	it("is read into the host's binding, then hidden from every process the host spawns", () => {
		process.env.SENPI_RPC_HOST_WATCH_PPID = String(process.pid);
		process.env[HOST_WATCH_LIFETIME_FIFO_ENV] = "/nonexistent/hop/lifetime.fifo";
		const { watchdogConfig } = internalHostTransport(readHostWatchdogConfigFromBrandEnv(), undefined);
		expect(watchdogConfig?.lifetimeFifo).toBe("/nonexistent/hop/lifetime.fifo");
		const childSees = execFileSync(
			process.execPath,
			["-e", `process.stdout.write(process.env.${HOST_WATCH_LIFETIME_FIFO_ENV} ?? "unset")`],
			{
				encoding: "utf8",
			},
		);
		expect(childSees).toBe("unset");
	});
});
