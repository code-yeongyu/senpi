/**
 * `senpi host` over the named-pipe transport - the win32 cell of the same command contract.
 *
 * Two properties differ there and only there: the endpoint is a pipe derived from the socket path
 * (so "is the daemon already running?" is answered by the pipe, not by a file), and a generation
 * handoff is IMPOSSIBLE - a named pipe can be neither renamed nor drained, and win32 has no SIGUSR1 -
 * so the command must refuse instead of attempting one. Everything else is covered on POSIX.
 *
 * The daemon is ended through the PID this test's ensure reported, with process handles opened
 * before stop: CIM registration identity can be unreadable, and `pgrep` does not exist here.
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	type HostCliSandbox,
	hostCliSandbox,
	onlyJsonLine,
	runHostCli,
	sweepHostCliSandboxes,
} from "./host-cli-support.ts";

const completed: HostCliSandbox[] = [];

afterEach(async () => {
	await sweepHostCliSandboxes();
	for (const sandbox of completed.splice(0)) {
		for (const pid of sandbox.ownedPids) expect(() => process.kill(pid, 0)).toThrow();
		expect(existsSync(sandbox.root)).toBe(false);
	}
}, 120_000);

describe.skipIf(process.platform !== "win32")("senpi host on named pipes", () => {
	it("reuses the daemon a first ensure started on the pipe", async () => {
		const qa = await hostCliSandbox("pipe");
		completed.push(qa);
		const first = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));
		expect(first).toMatchObject({ action: "start", reused: false });
		expect([...qa.ownedPids]).toContain(first.pid);

		const second = await runHostCli(qa, ["ensure", "--json"]);

		expect(second.exitCode).toBe(0);
		expect(onlyJsonLine(second)).toMatchObject({ action: "reuse", reused: true, instanceId: first.instanceId });
	}, 180_000);

	it("refuses a generation handoff, because a pipe can be neither renamed nor drained", async () => {
		const qa = await hostCliSandbox("handoff");
		completed.push(qa);
		const started = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));
		expect(started).toMatchObject({ action: "start" });
		expect([...qa.ownedPids]).toContain(started.pid);

		const result = await runHostCli(qa, ["handoff", "--json"]);

		expect(result.exitCode).toBe(3);
		expect(onlyJsonLine(result)).toMatchObject({ action: "refuse", reason: "upgrade_unsupported" });
	}, 180_000);
});
