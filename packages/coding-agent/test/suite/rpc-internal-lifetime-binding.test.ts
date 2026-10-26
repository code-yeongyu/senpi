import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, constants, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareLifetimeBinding } from "../../src/modes/rpc/host-lifetime-binding.ts";
import { armHostWatchdog, readHostWatchdogConfig } from "../../src/modes/rpc/host-watchdog.ts";
import { processExitEvent } from "../helpers/process-exit-event.ts";

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

function hopDir(): string {
	const dir = mkdtempSync("/tmp/r3816b-");
	chmodSync(dir, 0o700);
	roots.push(dir);
	return dir;
}

/** A lifetime FIFO with a live writer, the way the supervisor holds one. */
function lifetimeFifo(): { path: string; writer: number } {
	const path = join(hopDir(), "lifetime.fifo");
	execFileSync("mkfifo", ["-m", "600", path]);
	const writer = openSync(path, constants.O_RDWR);
	writers.push(writer);
	return { path, writer };
}

// senpi#3816 round 7: one interface (prepareLifetimeBinding / armLifetimeBinding) carries supervisor death to the host
// as an event on every POSIX platform: the lifetime FIFO on Linux, the reopened stdin on macOS.
describe.skipIf(process.platform === "win32")("lifetime binding interface", () => {
	it("prepares this platform's binding in the private hop directory", () => {
		const dir = hopDir();
		const binding = prepareLifetimeBinding(dir);
		try {
			if (process.platform === "linux") {
				expect(binding.lifetimeFifo).toBe(join(dir, "lifetime.fifo"));
				expect(statSync(join(dir, "lifetime.fifo")).isFIFO()).toBe(true);
				expect(statSync(join(dir, "lifetime.fifo")).mode & 0o777).toBe(0o600);
			} else expect(binding).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each(["node", "bun"])(
		"a %s host sees its supervisor's SIGKILL within 1 s through the platform binding",
		async (runtime) => {
			const supervisor = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					join(import.meta.dirname, "rpc-internal-lifetime-binding-supervisor.ts"),
					runtime,
					hopDir(),
				],
				{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
			);
			const supervisorExit = once(supervisor, "exit");
			try {
				const [ready] = (await once(supervisor, "message")) as [
					{ host: number; armed: string; fifo: string | null },
				];
				expect(ready.armed).toBe("armed");
				expect(ready.fifo !== null).toBe(process.platform === "linux");
				const hostExit = await processExitEvent(ready.host);
				try {
					supervisor.kill("SIGKILL");
					await hostExit.wait(1_000, `${runtime} host after its supervisor's SIGKILL`);
				} finally {
					await hostExit.dispose();
				}
			} finally {
				if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
				await supervisorExit;
			}
		},
		30_000,
	);

	it("an idle host with its event binding makes no liveness wakes in 10 s (one long backstop only)", async () => {
		const fifo = lifetimeFifo();
		// Linux binds through the FIFO path; macOS through a lifetime descriptor (its reopened stdin, here a stand-in).
		const binding =
			process.platform === "linux"
				? { SENPI_RPC_HOST_LIFETIME_FIFO: fifo.path }
				: { lifetimeFd: openSync(fifo.path, constants.O_RDONLY | constants.O_NONBLOCK) };
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const env = { SENPI_RPC_HOST_WATCH_PPID: "4242", SENPI_RPC_HOST_WATCH_PSTART_TICKS: "123456" };
		const config =
			"lifetimeFd" in binding
				? { ...readHostWatchdogConfig(env), lifetimeFd: binding.lifetimeFd }
				: readHostWatchdogConfig({ ...env, ...binding });
		const stop = armHostWatchdog(config, vi.fn());
		try {
			await vi.advanceTimersByTimeAsync(10_000);
			expect(kill.mock.calls.filter(([pid, signal]) => pid === 4242 && signal === 0)).toHaveLength(0);
		} finally {
			stop();
		}
	});
});
