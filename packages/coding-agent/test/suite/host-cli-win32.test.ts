/**
 * `senpi host` over the named-pipe transport - the win32 cell of the same command contract.
 *
 * Two properties differ there and only there: the endpoint is a pipe derived from the socket path
 * (so "is the daemon already running?" is answered by the pipe, not by a file), and a generation
 * handoff is IMPOSSIBLE - a named pipe can be neither renamed nor drained, and win32 has no SIGUSR1 -
 * so the command must refuse instead of attempting one. Everything else is covered on POSIX.
 *
 * The daemon is ended by the shared sweep, which stops it through its registration rather than by
 * argv: `pgrep` does not exist here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { hostCliSandbox, onlyJsonLine, runHostCli, sweepHostCliSandboxes } from "./host-cli-support.ts";

afterEach(async () => {
	await sweepHostCliSandboxes();
}, 120_000);

describe.skipIf(process.platform !== "win32")("senpi host on named pipes", () => {
	it("reuses the daemon a first ensure started on the pipe", async () => {
		const qa = await hostCliSandbox("pipe");
		const first = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));
		expect(first).toMatchObject({ action: "start", reused: false });

		const second = await runHostCli(qa, ["ensure", "--json"]);

		expect(second.exitCode).toBe(0);
		expect(onlyJsonLine(second)).toMatchObject({ action: "reuse", reused: true, instanceId: first.instanceId });
	}, 180_000);

	it("refuses a generation handoff, because a pipe can be neither renamed nor drained", async () => {
		const qa = await hostCliSandbox("handoff");
		expect(onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]))).toMatchObject({ action: "start" });

		const result = await runHostCli(qa, ["handoff", "--json"]);

		expect(result.exitCode).toBe(3);
		expect(onlyJsonLine(result)).toMatchObject({ action: "refuse", reason: "upgrade_unsupported" });
	}, 180_000);
});
