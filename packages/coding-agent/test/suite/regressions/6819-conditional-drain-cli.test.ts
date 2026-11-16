import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { connectAuthenticatedRpcSocket } from "../../../src/modes/rpc/rpc-auth-client.ts";
import { hostCliSandbox, onlyJsonLine, runHostCli, sweepHostCliSandboxes } from "../host-cli-support.ts";
import { Peer } from "../rpc-delegated-peer.ts";

afterEach(sweepHostCliSandboxes, 120_000);

// senpi#6819: the desktop consumes this process contract, including the supervisor's positive exit evidence.
it("refuses an attached generation with exit 3, then drains its detached session and supervisor with exit 0", async () => {
	const qa = await hostCliSandbox("6819");
	const ensured = await runHostCli(qa, ["ensure"]);
	expect(ensured.exitCode, ensured.stdout + ensured.stderr).toBe(0);
	const owner = z.object({ pid: z.number(), instanceId: z.string() }).parse(onlyJsonLine(ensured));
	const { socket } = await connectAuthenticatedRpcSocket(qa.socket, undefined, { keyRoot: qa.agentDir });
	const peer = new Peer(socket, "6819");
	try {
		const opened = await peer.send({ type: "open_session", retain_on_disconnect: true });
		expect(opened.success).toBe(true);
		const { sessionId } = z.object({ sessionId: z.string() }).parse(opened.data);
		const args = ["stop", "--drain", "--instance", owner.instanceId, "--if-idle"];
		const refused = await runHostCli(qa, args);
		expect(refused.exitCode, refused.stderr).toBe(3);
		expect(onlyJsonLine(refused)).toEqual({ action: "refuse", reason: "host_attached" });
		expect(await peer.send({ type: "release_attachment", sessionId })).toMatchObject({ success: true });
		const drained = await runHostCli(qa, [...args, "--wait-ms", "20000"]);
		expect(drained.exitCode, drained.stderr).toBe(0);
		expect(onlyJsonLine(drained)).toEqual({ action: "drained", ...owner, exited: true });
	} finally {
		socket.destroy();
	}
}, 180_000);

it("omits exited without wait and rejects an incomplete conditional command as usage", async () => {
	const qa = await hostCliSandbox("6819-nowait");
	const invalid = await runHostCli(qa, ["stop", "--drain", "--if-idle"]);
	expect(invalid.exitCode).toBe(2);
	const ensured = await runHostCli(qa, ["ensure"]);
	expect(ensured.exitCode, ensured.stdout + ensured.stderr).toBe(0);
	const owner = z.object({ pid: z.number(), instanceId: z.string() }).parse(onlyJsonLine(ensured));
	const result = await runHostCli(qa, ["stop", "--drain", "--instance", owner.instanceId, "--if-idle"]);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(onlyJsonLine(result)).toEqual({ action: "drained", ...owner });
}, 180_000);
