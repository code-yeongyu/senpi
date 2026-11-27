// senpi#7132: a draining host whose turn is still streaming must refuse a normal stop through both stop paths, finish
// the turn, end by itself once it holds nothing, and leave the complete answer in the durable session exactly once.
// Real supervisor, real host child: a draining child destroys every connection that reaches it after its drain began,
// so only a host that does that shows whether a stop can still read what it holds.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { probeProtocolInfo, probeSessionCount } from "../../../src/modes/rpc/host-probe.ts";
import { HOST_EXIT_REFUSED, runHostRequest } from "../../../src/modes/rpc/host-runner.ts";
import { signalGeneration, stopHost } from "../../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	HeldAnthropicModel,
	JsonlPeer,
	openedSessionId,
	supervisorLaunch,
	type WireRecord,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { reapProcessesUnder, waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const models: HeldAnthropicModel[] = [];
const supervisors: number[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const pid of supervisors.splice(0)) {
		if (!signalGeneration(pid, "SIGKILL")) continue;
		await waitForPidGone(pid, 20_000);
	}
	for (const model of models.splice(0)) await model.close();
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true });
	}
}, 120_000);

async function ensure(qa: GenerationScratch): Promise<number> {
	const ensured = await ensureHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		// Long enough that only the drain under test can end this generation.
		policy: { idleExitMs: 600_000 },
		hostArgs: [...GENERATION_HOST_ARGS],
		env: generationEnv(qa),
		_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
	});
	supervisors.push(ensured.pid);
	ensured.release();
	return ensured.pid;
}

async function peer(qa: GenerationScratch): Promise<JsonlPeer> {
	const connected = await JsonlPeer.connect(qa.socket);
	peers.push(connected);
	return connected;
}

function assistantTexts(response: WireRecord): string[] {
	const data = response.data as { messages?: unknown } | undefined;
	const messages = Array.isArray(data?.messages) ? data.messages : [];
	return messages.flatMap((message: { role?: unknown; content?: unknown }) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
		return [
			message.content
				.map((block: { type?: unknown; text?: unknown }) => (block.type === "text" ? String(block.text) : ""))
				.join(""),
		];
	});
}

// A drain is relayed to a POSIX child by SIGUSR1 next to its request file; this rig needs the POSIX socket path.
describe.skipIf(process.platform === "win32")("a draining host with a turn still streaming (senpi#7132)", () => {
	it("refuses a normal stop, finishes the turn, exits empty, and keeps the whole answer once", async () => {
		const held = await HeldAnthropicModel.start({ midStream: true });
		models.push(held);
		const qa = generationScratch("7132h");
		scratches.push(qa);
		writeRpcModelsJson(qa.agentDir, held.origin);
		const first = await ensure(qa);
		const sessionPath = join(realpathSync(qa.sessionDir), "streaming.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date(0).toISOString(),
			cwd: qa.cwd,
		};
		await writeFile(sessionPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
		const client = await peer(qa);
		const sessionId = openedSessionId(
			await client.request({ id: "open", type: "open_session", cwd: qa.cwd, sessionPath }),
		);
		const streaming = client.waitFor(
			(record) => record.type === "message_update" && JSON.stringify(record).includes("held turn "),
			60_000,
		);
		await client.request({ id: "prompt", type: "prompt", sessionId, message: "answer while the host drains" });
		await streaming;

		const draining = client.waitFor((record) => record.type === "host_superseded", 60_000);
		expect(await stopHost({ socket: qa.socket, agentDir: qa.agentDir, drain: true })).toMatchObject({
			action: "drained",
		});
		await draining;
		expect(await probeProtocolInfo(qa.socket, 10_000)).toMatchObject({ lifecycle: "stopping" });

		// Both readers of a stop see the session the draining host still holds, and both stop paths refuse.
		expect(await probeSessionCount(qa.socket, 10_000)).toBe(1);
		expect(await stopHost({ socket: qa.socket, agentDir: qa.agentDir })).toEqual({
			action: "refuse",
			reason: "sessions_live",
		});
		const cli = await runHostRequest({
			action: "stop",
			target: { socket: qa.socket, agentDir: qa.agentDir },
			drain: false,
			force: false,
		});
		expect(cli.exitCode).toBe(HOST_EXIT_REFUSED);
		expect(cli.payload).toMatchObject({ action: "refuse", reason: "sessions_live", sessions: { total: 1 } });

		const ended = client.waitFor((record) => record.type === "agent_end" && record.sessionId === sessionId, 60_000);
		held.release();
		await ended;
		// Empty once its turn settled and the session parked: the drained generation ends by itself.
		expect(await waitForPidGone(first, 90_000)).toBe(true);

		await ensure(qa);
		const reader = await peer(qa);
		const reopened = openedSessionId(
			await reader.request({ id: "reopen", type: "open_session", cwd: qa.cwd, sessionPath }, 60_000),
		);
		const history = await reader.request({ id: "history", type: "get_messages", sessionId: reopened });
		expect(assistantTexts(history)).toEqual(["held turn complete"]);
	});
});
