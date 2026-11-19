// Regression for senpi issue #7018: a host on a NEWER engine was handed down to an older desktop runtime's
// engine (forced handoff and idle handover alike), moving every session to it and dropping find_session.
// A handoff onto a newer host is refused `older_engine` and leaves the host, its generation and its sessions
// untouched; an upgrade, an equal build and an explicit downgrade still hand off. The ordering itself is
// pinned in test/suite/engine-build-identity.test.ts. senpi#7040 (gate a3): a successor whose engine is stated as an
// omo version ([5,1,78,0,0]) is not proven not older than a CalVer host, so it is refused too, under its own reason
// `unordered_engine` (senpi#7044).
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EngineBuildIdentity,
	engineBuildIdentity,
	engineBuildIdentityFrom,
} from "../../../src/core/engine-build-identity.ts";
import { handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import { signalGeneration } from "../../../src/modes/rpc/host-stop.ts";
import {
	generationEnv,
	type JsonlPeer,
	openedSessionId,
	reapProcessesUnder,
	supervisorLaunch,
	waitForPidGone,
} from "../../helpers/rpc-generation-support.ts";
import {
	beginHandoverCommand,
	connect,
	dataOf,
	expectServing,
	type HandoverRig,
	startHandoverRig,
} from "../../helpers/rpc-idle-handover-support.ts";

const OLDER: EngineBuildIdentity = engineBuildIdentityFrom({ version: "2000.1.1" });
const NEWER: EngineBuildIdentity = engineBuildIdentityFrom({ version: "2999.1.1" });
// senpi#7040: a compiled omo 5.1.78 states its omo version as its engine ([5,1,78,0,0]); it is never proven not older.
const OMO_VERSION: EngineBuildIdentity = engineBuildIdentityFrom({ version: "5.1.78" });

function wireEngine(identity: EngineBuildIdentity): { text: string; ordinal: readonly number[] } {
	return { text: identity.text, ordinal: identity.ordinal };
}

const rigs: HandoverRig[] = [];
const peers: JsonlPeer[] = [];
const pids: number[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const pid of pids.splice(0)) if (signalGeneration(pid, "SIGKILL")) await waitForPidGone(pid, 20_000);
	for (const rig of rigs.splice(0)) {
		await reapProcessesUnder(rig.qa.root);
		await rm(rig.qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

async function rig(label: string): Promise<HandoverRig> {
	const started = await startHandoverRig(label);
	rigs.push(started);
	pids.push(started.firstPid);
	return started;
}

function directHandoff(host: HandoverRig, options: { successorEngine: EngineBuildIdentity; allowDowngrade?: boolean }) {
	let spawned = false;
	const result = handoffHost({
		socket: host.qa.socket,
		agentDir: host.qa.agentDir,
		hostArgs: [...host.buildB.hostArgs],
		env: generationEnv(host.qa),
		...options,
		_test: {
			launch: supervisorLaunch,
			readinessTimeoutMs: 20_000,
			afterSpawn: async () => {
				spawned = true;
			},
		},
	});
	return { result, spawned: () => spawned };
}

describe.skipIf(process.platform === "win32")("a handoff onto a newer engine", () => {
	it.each([
		["an older engine", OLDER, "older_engine"],
		["an engine stated as an omo version", OMO_VERSION, "unordered_engine"],
	])(
		"refuses a newer host asked to hand over to %s, and keeps its sessions",
		async (_label, successorEngine, reason) => {
			const host = await rig("oe-direct");
			const caller = await connect(host, peers);
			const sessionId = openedSessionId(
				await caller.request({ id: "open", type: "open_session", cwd: host.qa.cwd }),
			);

			const handoff = directHandoff(host, { successorEngine });
			const result = await handoff.result;

			expect(result).toMatchObject({ action: "refuse", reason });
			expect(handoff.spawned()).toBe(false);
			await expectServing(host, caller, sessionId);
		},
	);

	it("refuses an idle handover to an older engine, to one stated as an omo version, and to a requester that does not state its engine", async () => {
		const host = await rig("oe-idle");
		const caller = await connect(host, peers);
		const sessionId = openedSessionId(await caller.request({ id: "open", type: "open_session", cwd: host.qa.cwd }));

		const older = dataOf(
			await caller.request(beginHandoverCommand(host, { target_engine: wireEngine(OLDER) }), 120_000),
		);
		const unstated = dataOf(
			await caller.request(
				beginHandoverCommand(host, { id: "begin-2", operation_id: "op-2", target_engine: undefined }),
				120_000,
			),
		);
		const omoVersion = dataOf(
			await caller.request(
				beginHandoverCommand(host, { id: "begin-3", operation_id: "op-3", target_engine: wireEngine(OMO_VERSION) }),
				120_000,
			),
		);

		expect(older).toMatchObject({ refused: "older_engine" });
		expect(unstated).toMatchObject({ refused: "older_engine" });
		expect(omoVersion).toMatchObject({ refused: "unordered_engine" });
		await expectServing(host, caller, sessionId);
	});

	it("hands over to an older engine when the caller explicitly allows the downgrade", async () => {
		const host = await rig("oe-allow");

		const result = await directHandoff(host, { successorEngine: OLDER, allowDowngrade: true }).result;

		expect(result).toMatchObject({ action: "handoff" });
		if (result.action === "handoff") pids.push(result.pid);
		expect((await probeHost({ socket: host.qa.socket }))?.instanceId).not.toBe(host.instanceId);
	});

	it("hands over to an idle-handover requester that allows the downgrade", async () => {
		const host = await rig("oe-idle-allow");
		const caller = await connect(host, peers);

		const answer = dataOf(
			await caller.request(
				beginHandoverCommand(host, { target_engine: wireEngine(OLDER), allow_downgrade: true }),
				120_000,
			),
		);

		expect(answer).toMatchObject({ state: "handover_completed" });
	});

	it.each([
		["a newer", NEWER],
		["an equal", engineBuildIdentity()],
	])("still hands over to %s successor engine", async (_label, successorEngine) => {
		const host = await rig("oe-upgrade");

		const result = await directHandoff(host, { successorEngine }).result;

		expect(result).toMatchObject({ action: "handoff" });
		if (result.action === "handoff") pids.push(result.pid);
	});
});
