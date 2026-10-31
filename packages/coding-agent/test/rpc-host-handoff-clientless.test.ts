import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { readHostStatus } from "../src/modes/rpc/host-status.ts";
import { signalGeneration } from "../src/modes/rpc/host-stop.ts";
import {
	type GenerationScratch,
	type HeldAnthropicModel,
	type JsonlPeer,
	reapProcessesUnder,
	waitForPidGone,
} from "./helpers/rpc-generation-support.ts";
import {
	beginHandoverCommand,
	connect,
	dataOf,
	type HandoverRig,
	startHandoverRig,
} from "./helpers/rpc-idle-handover-support.ts";

// Diagnostic dump for a failure of the reopen assertion below: capture the listed durable ids, the
// transcript's existence, and the handover-parked record tree (entry contents included) so a lost
// session is identifiable from the test log instead of a bare assertion (senpi#3282).
async function dumpReopenFailure(
	rig: { qa: GenerationScratch },
	openedState: { durableSessionId?: string; sessionFile?: string } | undefined,
	lastListed: readonly string[],
): Promise<void> {
	const lines: string[] = [];
	lines.push(`[reopen-dump] lastListed=${JSON.stringify(lastListed)}`);
	const sessionFile = openedState?.sessionFile;
	lines.push(
		`[reopen-dump] sessionFile=${sessionFile ?? "<none>"} exists=${sessionFile !== undefined ? existsSync(sessionFile) : "n/a"}`,
	);
	const daemonRoot = join(rig.qa.agentDir, "rpc-host-daemon");
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > 4) return;
		let names: string[] = [];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			lines.push(`[reopen-dump] ${path}`);
			if (name.endsWith(".json") && dir.endsWith("handover-parked")) {
				try {
					lines.push(`[reopen-dump] entry ${name}: ${await readFile(path, "utf8")}`);
				} catch {}
			}
			if (name === "handover-parked" || depth < 3) await walk(path, depth + 1);
		}
	};
	await walk(daemonRoot, 0);
	process.stderr.write(`${lines.join("\n")}\n`);
}

interface SuccessorInfo {
	readonly pid: number;
	readonly instanceId: string;
	readonly generation: number;
	readonly runtimeBuildId: string;
}

// Drives a conditional handover until the target build serves the socket. A host that is still
// settling work answers handover_pending and switches over on its own once idle; it then drains the
// connection it answered on, so completion is read from the socket (the process and build that
// answer it), never from a reply on that connection. Every attempt opens a fresh
// connection and uses its own request id: JsonlPeer.request resolves on the first stored response
// with a given id.
async function handOverUntilServed(
	rig: HandoverRig,
	from: { readonly instanceId: string },
	targetRuntimeBuildId: string,
	overrides: Record<string, unknown>,
	label: string,
): Promise<SuccessorInfo | { readonly lastAnswer: Record<string, unknown> }> {
	let lastAnswer: Record<string, unknown> = {};
	const deadline = Date.now() + 120_000;
	for (let attempt = 0; Date.now() < deadline; attempt++) {
		const caller = await connect(rig, peers);
		try {
			lastAnswer = dataOf(
				await caller.request(beginHandoverCommand(rig, { ...overrides, id: `${label}-${attempt}` }), 20_000),
			);
		} catch (cause) {
			lastAnswer = { state: "no_answer", cause: String(cause) };
		} finally {
			caller.destroy();
		}
		// A handoff is complete exactly when the process answering the socket changes
		// (HostProtocolInfo.instanceId). The status pointer's `current` flag can lag behind it.
		const serving = await probeHost({ socket: rig.qa.socket }).catch(() => undefined);
		if (
			serving?.instanceId !== undefined &&
			serving.instanceId !== from.instanceId &&
			serving.generation !== undefined &&
			serving.runtimeBuildId === targetRuntimeBuildId
		) {
			const status = await readHostStatus({ socket: rig.qa.socket, agentDir: rig.qa.agentDir }).catch(
				() => undefined,
			);
			const row = status?.generations.find((generation) => generation.instanceId === serving.instanceId);
			if (row !== undefined)
				return {
					pid: row.pid,
					instanceId: serving.instanceId,
					generation: serving.generation,
					runtimeBuildId: targetRuntimeBuildId,
				};
		}
		lastAnswer = { ...lastAnswer, serving: serving && { id: serving.instanceId, gen: serving.generation } };
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return { lastAnswer };
}

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const models: HeldAnthropicModel[] = [];
const pids: number[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const model of models.splice(0)) {
		model.release();
		await model.close();
	}
	for (const pid of pids.splice(0)) if (signalGeneration(pid, "SIGKILL")) await waitForPidGone(pid, 20_000);
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

describe.skipIf(process.platform === "win32")("client-less retained sessions across a generation handoff", () => {
	it("the successor host reopens the predecessor's handoff_parked retained session with the same durable id", async () => {
		const rig = await startHandoverRig("ih-clientless");
		scratches.push(rig.qa);
		pids.push(rig.firstPid);

		const opener = await connect(rig, peers);
		const opened = dataOf(
			await opener.request({
				id: "open",
				type: "open_session",
				cwd: rig.qa.cwd,
				retain_on_disconnect: true,
			}),
		);
		const openedState = opened.state as { durableSessionId?: string; sessionFile?: string } | undefined;
		// A real retained session has a transcript on disk; the file is written incrementally during a
		// turn. Drive one turn so the file exists, then abort it (the conditional handover waits for no
		// busy session; the retry below absorbs the abort's settle timing).
		await opener.request({ id: "turn", type: "prompt", sessionId: opened.sessionId, message: "say ok" }, 120_000);
		await opener.request({ id: "abort", type: "abort", sessionId: opened.sessionId }, 120_000);
		const durableId =
			typeof openedState?.durableSessionId === "string"
				? openedState.durableSessionId
				: /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
						openedState?.sessionFile ?? "",
					)?.[1];
		expect(typeof durableId).toBe("string");
		opener.destroy();

		// The conditional idle handover refuses while the just-aborted turn is still settling; retry
		// until it admits the handoff, so the test does not hinge on the abort's settle timing.
		const successor = await handOverUntilServed(rig, rig, rig.buildB.runtimeBuildId, {}, "begin");
		if (!("pid" in successor)) throw new Error(`first handover did not complete: ${JSON.stringify(successor)}`);
		pids.push(successor.pid);
		expect(await waitForPidGone(rig.firstPid, 60_000)).toBe(true);

		let listRequests = 0;
		// A fresh connection per poll: the second handover drains every connection to the host it replaces.
		const listDurableIds = async (): Promise<string[]> => {
			const lister = await connect(rig, peers);
			let listed: Record<string, unknown>;
			try {
				listed = dataOf(
					await lister.request({ id: `list-${listRequests++}`, type: "list_sessions", include_workers: true }),
				);
			} finally {
				lister.destroy();
			}
			return ((listed.sessions ?? []) as Array<{ durableSessionId?: string }>)
				.map((row) => row.durableSessionId)
				.filter((id): id is string => typeof id === "string");
		};

		// After the first handover the session must be OPEN with the same durable id: a successor
		// that leaves it only in the parked record (or drops it) FAILS, because the production bug is
		// exactly that the reopened session never comes back open (senpi#3282).
		const deadline1 = Date.now() + 60_000;
		let openAfterFirst = false;
		let lastListed: string[] = [];
		while (!openAfterFirst && Date.now() < deadline1) {
			lastListed = await listDurableIds();
			openAfterFirst = lastListed.includes(durableId!);
			if (!openAfterFirst) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (!openAfterFirst) await dumpReopenFailure(rig, openedState, lastListed);
		expect(openAfterFirst, `durable ${durableId} not open after the first handover`).toBe(true);

		// After a SECOND handover the session is open again with the same durable id.
		const successor2 = await handOverUntilServed(
			rig,
			successor,
			rig.buildA.runtimeBuildId,
			{
				operation_id: "op-2",
				if_instance_id: successor.instanceId,
				if_generation: successor.generation,
				target_runtime_build_id: rig.buildA.runtimeBuildId,
				host_args: rig.buildA.hostArgs,
			},
			"begin2",
		);
		if (!("pid" in successor2)) throw new Error(`second handover did not complete: ${JSON.stringify(successor2)}`);
		pids.push(successor2.pid);
		const deadline2 = Date.now() + 60_000;
		let openAgain = false;
		while (!openAgain && Date.now() < deadline2) {
			openAgain = (await listDurableIds()).includes(durableId!);
			if (!openAgain) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		expect(openAgain, `durable ${durableId} not open after the second handover`).toBe(true);
	}, 300_000);
});
