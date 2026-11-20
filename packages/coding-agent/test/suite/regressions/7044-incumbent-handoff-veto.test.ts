// Regression for senpi issue #7044: the older-engine refusal of #7018 / #7023 ran only in the REQUESTER of a handoff,
// so any client released before it took a newer host with a plain `host handoff` and moved every session to its older
// engine. The incumbent decides now. It answers `admit_handoff` itself (older and unordered successors are refused),
// drains only for the admission presented on the connection that was admitted (`drain_for_handoff`), no longer
// advertises the `generation_handoff` a pre-fix client consults before it spawns a successor, and ignores a bare
// SIGUSR1. Every case asks a real supervised host over its public socket.
import { watch } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EngineBuildIdentity,
	engineBuildIdentity,
	engineBuildIdentityFrom,
} from "../../../src/core/engine-build-identity.ts";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import { signalGeneration, stopHost } from "../../../src/modes/rpc/host-stop.ts";
import {
	generationEnv,
	type JsonlPeer,
	openedSessionId,
	reapProcessesUnder,
	supervisorLaunch,
	waitForPidGone,
	type WireRecord,
} from "../../helpers/rpc-generation-support.ts";
import {
	connect,
	dataOf,
	expectServing,
	type HandoverRig,
	startHandoverRig,
} from "../../helpers/rpc-idle-handover-support.ts";

const OLDER: EngineBuildIdentity = engineBuildIdentityFrom({ version: "2000.1.1" });
// A compiled omo through 5.1.78 stated its omo version as its engine: an ordinal outside senpi CalVer (senpi#7040).
const OMO_VERSION: EngineBuildIdentity = engineBuildIdentityFrom({ version: "5.1.78" });

function wireEngine(identity: EngineBuildIdentity): WireRecord {
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

/**
 * One record sent to the host itself, and the host's answer to it. A host that does not know the record answers a
 * `parse` error without the id; that is an answer too, and waiting for it keeps a refusal from reading as a timeout.
 */
async function ask(peer: JsonlPeer, command: WireRecord): Promise<WireRecord> {
	const answered = peer.waitFor(
		(record) => record.type === "response" && (record.id === command.id || record.command === "parse"),
	);
	peer.send(command);
	return answered;
}

/**
 * The lines of the daemon log (the supervisor and its host both write it) that name `text`, once there are `count` of
 * them. Subscribed before it returns, so call it before the trigger. It never rejects: at its deadline it answers with
 * the lines it has, and the caller's assertion on them is the failure.
 */
function logLines(host: HandoverRig, text: string, count: number): Promise<readonly string[]> {
	const log = createHostDaemonPaths({ socket: host.qa.socket, agentDir: host.qa.agentDir }).stderrLog;
	const matching = async (): Promise<readonly string[]> =>
		(await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line.includes(text));
	return new Promise((resolve) => {
		const settle = (lines: readonly string[]): void => {
			clearTimeout(deadline);
			watcher.close();
			resolve(lines);
		};
		const check = (): void => {
			void matching().then((lines) => {
				if (lines.length >= count) settle(lines);
			});
		};
		const watcher = watch(dirname(log), check);
		const deadline = setTimeout(() => void matching().then(settle), 15_000);
		check();
	});
}

async function hostChildPid(host: HandoverRig): Promise<number> {
	const paths = createHostDaemonPaths({ socket: host.qa.socket, agentDir: host.qa.agentDir });
	const record: unknown = JSON.parse(await readFile(generationPaths(paths, host.instanceId).childPidFile, "utf8"));
	const pid = typeof record === "object" && record !== null ? Reflect.get(record, "pid") : undefined;
	if (typeof pid !== "number") throw new Error("the host child recorded no pid");
	return pid;
}

describe.skipIf(process.platform === "win32")("a handoff the incumbent host did not admit", () => {
	it.each([
		["an older CalVer engine", wireEngine(OLDER), "older_engine"],
		["an engine stated as an omo version", wireEngine(OMO_VERSION), "unordered_engine"],
		["no engine at all", undefined, "unordered_engine"],
	])(
		"is refused by the host itself for a successor on %s, which keeps its pid and session",
		async (_label, successorEngine, refused) => {
			const host = await rig("iv-refuse");
			const caller = await connect(host, peers);
			const sessionId = openedSessionId(
				await caller.request({ id: "open", type: "open_session", cwd: host.qa.cwd }),
			);

			const answer = await ask(caller, {
				id: "admit",
				type: "admit_handoff",
				...(successorEngine !== undefined && { successor_engine: successorEngine }),
			});

			expect(answer).toMatchObject({ success: true, data: { refused } });
			expect(dataOf(answer)).not.toHaveProperty("admission_id");
			await expectServing(host, caller, sessionId);
		},
	);

	it("hands over to an older engine when the requester sends allow_downgrade, and the host log names the override", async () => {
		const host = await rig("iv-allow");
		const overridden = logLines(host, "allow_downgrade", 1);

		const result = await handoffHost({
			socket: host.qa.socket,
			agentDir: host.qa.agentDir,
			hostArgs: [...host.buildB.hostArgs],
			env: generationEnv(host.qa),
			successorEngine: OLDER,
			allowDowngrade: true,
			_test: { launch: supervisorLaunch, readinessTimeoutMs: 20_000 },
		});

		expect(result).toMatchObject({ action: "handoff" });
		if (result.action === "handoff") pids.push(result.pid);
		const lines = await overridden;
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(OLDER.text);
		expect(lines[0]).toContain(engineBuildIdentity().text);
		expect((await probeHost({ socket: host.qa.socket }))?.instanceId).not.toBe(host.instanceId);
	});

	// Protocol contract: a client from before the fix consults `generation_handoff` alone before it spawns a successor
	// or signals, so the advertised capability list is what keeps such a client attached instead.
	it("pins the advertised capability list: handoff_admission, and not the generation_handoff an older client consults", async () => {
		const host = await rig("iv-legacy");

		const capabilities = (await probeHost({ socket: host.qa.socket }))?.capabilities;

		expect(capabilities).toContain("handoff_admission");
		expect(capabilities).not.toContain("generation_handoff");
	});

	// senpi#7052 review L2: the admission was asked for before the requester's own refusals ran, so the host logged an
	// admission for a handoff that never happened.
	it("is not asked to admit a handoff that the requester's own checks refuse", async () => {
		const host = await rig("iv-local");

		const result = await handoffHost({
			socket: host.qa.socket,
			agentDir: join(host.qa.root, "another-agent-dir"),
			hostArgs: [...host.buildB.hostArgs],
			env: generationEnv(host.qa),
			_test: { launch: supervisorLaunch, readinessTimeoutMs: 20_000 },
		});

		expect(result).toMatchObject({ action: "refuse", reason: "foreign_agent_dir" });
		// The host writes its admission line before it answers and its log keeps the order: once the admission asked
		// for here is on record, one granted to the refused handoff would stand in front of it.
		const requester = await connect(host, peers);
		const admitted = dataOf(
			await ask(requester, {
				id: "admit",
				type: "admit_handoff",
				successor_engine: wireEngine(engineBuildIdentity()),
			}),
		);
		expect(admitted).toMatchObject({ admission_id: expect.any(String) });
		const own = `admission ${String(admitted.admission_id)}`;
		expect(await logLines(host, own, 1)).toHaveLength(1);
		expect(await logLines(host, "handoff admitted", 1)).toEqual([expect.stringContaining(own)]);
	});

	it("keeps serving when its supervisor and its host are sent a bare SIGUSR1, and logs each ignored signal", async () => {
		const host = await rig("iv-signal");
		const caller = await connect(host, peers);
		const sessionId = openedSessionId(await caller.request({ id: "open", type: "open_session", cwd: host.qa.cwd }));
		const ignored = logLines(host, "ignored SIGUSR1", 2);
		// A host that drains parks this session; the peer's teardown settles the wait when it never does.
		const parked = caller.waitFor(
			(record) => record.type === "session_closed" && record.sessionId === sessionId,
			60_000,
		);

		expect(signalGeneration(host.firstPid, "SIGUSR1")).toBe(true);
		expect(signalGeneration(await hostChildPid(host), "SIGUSR1")).toBe(true);

		const first = await Promise.race([ignored.then(() => "ignored"), parked.then(() => "drained")]);
		expect(first).toBe("ignored");
		expect(await ignored).toHaveLength(2);
		await expectServing(host, caller, sessionId);
	});

	it("drains only for the admission, presented on the connection that was admitted", async () => {
		const host = await rig("iv-drain");
		const requester = await connect(host, peers);
		const stranger = await connect(host, peers);
		const client = await connect(host, peers);
		const sessionId = openedSessionId(await client.request({ id: "open", type: "open_session", cwd: host.qa.cwd }));
		const admitted = dataOf(
			await ask(requester, {
				id: "admit",
				type: "admit_handoff",
				successor_engine: wireEngine(engineBuildIdentity()),
			}),
		);
		expect(admitted).toMatchObject({ admission_id: expect.any(String) });
		const admission = { type: "drain_for_handoff", admission_id: admitted.admission_id };

		expect(dataOf(await ask(stranger, { id: "steal", ...admission }))).toMatchObject({
			refused: "unknown_admission",
		});
		expect(
			dataOf(await ask(requester, { id: "guess", type: "drain_for_handoff", admission_id: "not-the-admission" })),
		).toMatchObject({ refused: "unknown_admission" });
		await expectServing(host, client, sessionId);

		const parked = client.waitFor((record) => record.type === "session_closed" && record.sessionId === sessionId);
		expect(dataOf(await ask(requester, { id: "drain", ...admission }))).toMatchObject({ draining: true });

		expect(await parked).toMatchObject({ reason: "handoff_parked" });
		expect(await waitForPidGone(host.firstPid, 20_000)).toBe(true);
	});

	// senpi#7052 review L1: the supervisor's SIGUSR1 only wakes the host to read the relay, so a relay that could not be
	// written left `stop --drain` with a supervisor that stopped admitting and a host that never drained.
	it("still drains for stop --drain when its supervisor cannot write the relay into the generation directory", async () => {
		const host = await rig("iv-relay");
		const client = await connect(host, peers);
		const sessionId = openedSessionId(await client.request({ id: "open", type: "open_session", cwd: host.qa.cwd }));
		const paths = createHostDaemonPaths({ socket: host.qa.socket, agentDir: host.qa.agentDir });
		// A directory where the relay belongs: the supervisor's rename onto it fails, and the host reads no request there.
		await mkdir(generationPaths(paths, host.instanceId).childDrainRequestFile);
		const relayFailed = logLines(host, "could not relay the drain", 1);
		const parked = client.waitFor((record) => record.type === "session_closed" && record.sessionId === sessionId);

		expect(await stopHost({ socket: host.qa.socket, agentDir: host.qa.agentDir, drain: true })).toMatchObject({
			action: "drained",
		});

		expect(await relayFailed).toHaveLength(1);
		expect(await parked).toMatchObject({ reason: "handoff_parked" });
		expect(await waitForPidGone(host.firstPid, 20_000)).toBe(true);
	});
});
