/**
 * `senpi host stop` against a daemon another client is using.
 *
 * A hard stop ends every session the daemon holds - including the ones that belong to other clients
 * of the same machine-wide host - so the carve-out this suite pins is the whole point of the
 * command: a plain `stop` refuses while somebody else is attached and SAYS what it counted, and
 * only `--force` goes through. The other client here is a real second connection holding a real
 * session, because a count the host did not produce would prove nothing.
 */
import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeModelServer, MOCK_MODEL, MOCK_PROVIDER, startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { JsonlPeer, openedSessionId } from "../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { waitForPidGone } from "../helpers/spawned-host-reaper.ts";
import {
	type HostCliSandbox,
	hostCliSandbox,
	onlyJsonLine,
	runHostCli,
	sweepHostCliSandboxes,
} from "./host-cli-support.ts";

const peers: JsonlPeer[] = [];
const models: FakeModelServer[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const model of models.splice(0)) await model.close();
	await sweepHostCliSandboxes();
}, 120_000);

describe.skipIf(process.platform === "win32")("senpi host stop", () => {
	it("refuses while another client holds a session, and names the counts", async () => {
		const qa = await occupiedDaemon("busy");

		const result = await runHostCli(qa.sandbox, ["stop", "--json"]);

		expect(result.exitCode).toBe(3);
		const payload = onlyJsonLine(result);
		expect(payload).toMatchObject({ action: "refuse", reason: "sessions_live" });
		expect(payload.sessions).toEqual({
			total: 1,
			interactive: 1,
			worker: 0,
			retained: 0,
			foreign_attached: 1,
			foreign_retained: 0,
		});
		// The refusal left the daemon alone: it is still answering.
		expect(onlyJsonLine(await runHostCli(qa.sandbox, ["status", "--json"]))).toMatchObject({ reachable: true });
	}, 120_000);

	it("stops past a foreign session when the operator forces it", async () => {
		const qa = await occupiedDaemon("forced");

		const result = await runHostCli(qa.sandbox, ["stop", "--json", "--force"]);

		expect(result.exitCode).toBe(0);
		const payload = onlyJsonLine(result);
		expect(payload).toMatchObject({ action: "stopped", pid: qa.pid });
		// The counts are still reported: forcing is an override, not a silence.
		expect(payload.sessions).toMatchObject({ total: 1, foreign_attached: 1 });
		expect(await waitForPidGone(qa.pid, 30_000)).toBe(true);
		await expect(stat(qa.sandbox.socket)).rejects.toMatchObject({ code: "ENOENT" });
	}, 120_000);
});

interface OccupiedDaemon {
	readonly sandbox: HostCliSandbox;
	readonly pid: number;
}

/** A daemon this suite started, with one session held open by a second connection to it. */
async function occupiedDaemon(label: string): Promise<OccupiedDaemon> {
	const sandbox = await hostCliSandbox(label);
	const model = await startFakeModelServer();
	models.push(model);
	writeRpcModelsJson(sandbox.agentDir, model.origin);
	const ensured = onlyJsonLine(await runHostCli(sandbox, ["ensure", "--json"]));
	const peer = await JsonlPeer.connect(sandbox.socket);
	peers.push(peer);
	openedSessionId(
		await peer.request({
			id: "open",
			type: "open_session",
			cwd: sandbox.root,
			provider: MOCK_PROVIDER,
			modelId: MOCK_MODEL,
		}),
	);
	return { sandbox, pid: ensured.pid as number };
}
