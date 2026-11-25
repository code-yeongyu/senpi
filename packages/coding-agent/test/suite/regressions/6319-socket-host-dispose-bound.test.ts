// senpi#6319: C5.b failed with "Hook timed out in 10000ms" in an afterEach that only disposes its socket test host.
// The teardown gave a slow host up to 10 s before killing it, the same 10 s vitest gives the whole hook, so a slow
// exit could never end as the teardown's own bounded, reported kill. It now gives a host the supervisor's stop
// window (CHILD_STOP_TIMEOUT_MS) from SIGTERM to SIGKILL. A stopped host never exits on SIGTERM.
import { afterEach, expect, it, vi } from "vitest";
import { startInProcessHost } from "../rpc-worker-host-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const HOOK_BUDGET_MS = 10_000;

async function disposeObserved(host: Awaited<ReturnType<typeof startInProcessHost>>): Promise<string> {
	const write = vi.spyOn(process.stderr, "write");
	await host.dispose();
	const written = write.mock.calls.map(([chunk]) => String(chunk)).join("");
	write.mockRestore();
	return written;
}

it(
	"disposes a socket host that exits on SIGTERM without killing it or reporting anything",
	async () => {
		// Given: a running socket host
		vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
		const host = await startInProcessHost();

		// When: the test tears it down
		const written = await disposeObserved(host);

		// Then: SIGTERM ended it, and the teardown reported nothing
		expect(host.child.signalCode).not.toBe("SIGKILL");
		expect(written).not.toContain("did not exit");
	},
	HOOK_BUDGET_MS,
);

it(
	"disposes a socket host that does not exit on SIGTERM inside the hook budget and reports the kill",
	async () => {
		// Given: a socket host whose process is stopped, so SIGTERM cannot end it
		vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
		const host = await startInProcessHost();
		const pid = host.child.pid;
		if (pid === undefined) throw new Error("host child has no pid");
		process.kill(pid, "SIGSTOP");

		// When: the test tears it down
		const written = await disposeObserved(host);

		// Then: it was killed, and the teardown said which host and why
		expect(host.child.signalCode).toBe("SIGKILL");
		expect(written).toContain(`test host ${pid} did not exit`);
	},
	HOOK_BUDGET_MS,
);
