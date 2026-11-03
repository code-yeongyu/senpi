import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";

const roots: string[] = [];
const writers: number[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const fd of writers.splice(0)) {
		try {
			closeSync(fd);
		} catch {}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A lifetime FIFO with a live writer, the way the supervisor holds one. */
function lifetimeFifo(): { path: string; writer: number } {
	const root = mkdtempSync("/tmp/r3816f-");
	roots.push(root);
	const path = join(root, "lifetime.fifo");
	execFileSync("mkfifo", ["-m", "600", path]);
	const writer = openSync(path, constants.O_RDWR);
	writers.push(writer);
	return { path, writer };
}

// senpi#3816 round 7 (lead ruling: FIFO): supervisor death reaches the host as an event on Linux and macOS.
describe.skipIf(process.platform === "win32")("lifetime event binding", () => {
	// Linux only: libuv reports a FIFO's EOF there; on macOS the reopened stdin is the event binding instead.
	it.skipIf(process.platform !== "linux").each(["node", "bun"])(
		"%s fires within 1 s of the last writer closing",
		async (runtime) => {
			const fifo = lifetimeFifo();
			const host = spawn(
				runtime,
				[
					...(runtime === "bun" ? [] : ["--import", "tsx"]),
					join(import.meta.dirname, "rpc-internal-lifetime-fifo-harness.ts"),
				],
				{
					env: {
						...hostSpawnEnv(),
						SENPI_RPC_HOST_WATCH_PPID: String(process.pid),
						SENPI_RPC_HOST_LIFETIME_FIFO: fifo.path,
					},
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				},
			);
			try {
				const [armed] = await once(host, "message");
				expect(armed).toEqual({ type: "armed" });
				const fired = once(host, "message");
				const started = performance.now();
				closeSync(fifo.writer);
				writers.splice(writers.indexOf(fifo.writer), 1);
				const [message] = await fired;
				expect(message).toMatchObject({ type: "fired" });
				expect(performance.now() - started).toBeLessThan(1_000);
			} finally {
				if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
			}
		},
		20_000,
	);
});
