// senpi#6319: C5.b failed with "Hook timed out in 10000ms" in an afterEach that only disposes its socket test host.
// The teardown gave a slow host up to 10 s before killing it, the same 10 s vitest gives the whole hook, so a slow
// exit could never end as the teardown's own bounded, reported kill. It now gives a host the supervisor's stop
// window (CHILD_STOP_TIMEOUT_MS) from SIGTERM to SIGKILL. Each case disposes its host in afterEach, under the real
// hook budget, as C5.b does; a stopped host never exits on SIGTERM.
import { afterEach, expect, it, vi } from "vitest";
import { startInProcessHost } from "../rpc-worker-host-support.ts";

type Host = Awaited<ReturnType<typeof startInProcessHost>>;

let teardown: { readonly host: Host; readonly held: boolean } | undefined;

afterEach(async () => {
	const current = teardown;
	teardown = undefined;
	if (current === undefined) return;
	const pid = current.host.child.pid;
	const write = vi.spyOn(process.stderr, "write");
	try {
		await current.host.dispose();
		const written = write.mock.calls.map(([chunk]) => String(chunk)).join("");
		if (current.held) {
			// Then: it was killed, and the teardown said which host and why
			expect(current.host.child.signalCode).toBe("SIGKILL");
			expect(written).toContain(`test host ${pid} did not exit`);
		} else {
			// Then: SIGTERM ended it, and the teardown reported nothing
			expect(current.host.child.signalCode).not.toBe("SIGKILL");
			expect(written).not.toContain("did not exit");
		}
	} finally {
		write.mockRestore();
		vi.unstubAllEnvs();
	}
});

it("disposes a socket host that exits on SIGTERM without killing it or reporting anything", async () => {
	// Given: a running socket host; When: the afterEach tears it down
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	teardown = { host: await startInProcessHost(), held: false };
});

it("disposes a socket host that does not exit on SIGTERM inside the hook budget and reports the kill", async () => {
	// Given: a socket host whose process is stopped, so SIGTERM cannot end it; When: the afterEach tears it down
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost();
	teardown = { host, held: true };
	const pid = host.child.pid;
	if (pid === undefined) throw new Error("host child has no pid");
	process.kill(pid, "SIGSTOP");
});
