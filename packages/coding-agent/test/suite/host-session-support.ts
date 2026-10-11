import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import * as hostEnsure from "../../src/modes/rpc/host-ensure.ts";
import { DEFAULT_HOST_LAUNCH_SPEC } from "../../src/modes/rpc/host-launch-spec.ts";
import { runHostSessionRequest } from "../../src/modes/rpc/host-session-runner.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { RpcClient, type RpcClientEvent } from "../../src/modes/rpc/rpc-client.ts";
import { type FakeModelServer, startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { HeldAnthropicModel, supervisorLaunch } from "../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { hostCliSandbox, sweepHostCliSandboxes } from "./host-cli-support.ts";

const dirs: string[] = [];
const clients: RpcClient[] = [];
const models: (FakeModelServer | HeldAnthropicModel)[] = [];
const closeWires: (() => Promise<void>)[] = [];
export function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hs-unit-"));
	dirs.push(dir);
	return dir;
}
export async function cleanupHostSessionRigs(): Promise<void> {
	for (const close of closeWires.splice(0)) await close();
	for (const client of clients.splice(0)) await client.stop();
	await sweepHostCliSandboxes();
	for (const model of models.splice(0)) {
		if (model instanceof HeldAnthropicModel) model.release();
		await model.close();
	}
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function rig(held = false, hostEnv: Readonly<Record<string, string>> = {}) {
	const qa = await hostCliSandbox("session");
	const cwd = join(qa.root, "work");
	mkdirSync(cwd);
	const fake = held ? await HeldAnthropicModel.start() : await startFakeModelServer();
	models.push(fake);
	writeRpcModelsJson(qa.agentDir, fake.origin, ["mock-claude-rpc-2"]);
	const ensure = hostEnsure.ensureHost;
	vi.spyOn(hostEnsure, "ensureHost").mockImplementation((options) =>
		ensure({ ...options, _test: { launch: supervisorLaunch, readinessTimeoutMs: 30_000 } }),
	);
	const target = { socket: qa.socket, agentDir: qa.agentDir };
	const spec = {
		...DEFAULT_HOST_LAUNCH_SPEC,
		// The runner's own HOME would load its user skills, whose MCP sidecars the host pools past a close.
		env: {
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_RUNTIME: "node",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			HOME: qa.root,
			USERPROFILE: qa.root,
			...hostEnv,
		},
	};
	const opened = await runHostSessionRequest({
		action: "open",
		target,
		cwd,
		spec,
		model: { provider: "anthropic", id: "mock-claude-rpc" },
		name: "lane-1",
	});
	expect(opened.exitCode, JSON.stringify(opened.payload)).toBe(0);
	const ref = String(opened.payload.sessionId);
	const client = new RpcClient({ socketPath: qa.socket });
	clients.push(client);
	await client.start();
	return { qa, cwd, target, spec, opened, ref, client, fake };
}

export function nextEvent(client: RpcClient, type: RpcClientEvent["type"]): Promise<RpcClientEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Missing ${type}`));
		}, 20_000);
		const unsubscribe = client.onEvent((event) => {
			if (event.type !== type) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(event);
		});
	});
}

/** A real socket with controlled wire ordering for races a model cannot schedule exactly. */
export async function wireRig(
	onState: (
		call: number,
		send: (record: Record<string, unknown>) => void,
		reply: (state: Record<string, unknown>) => void,
		socket: Socket,
	) => void,
) {
	const dir = scratch();
	const socket = join(dir, "wire.sock");
	const peers = new Set<Socket>();
	let stateReads = 0;
	const server = createServer((peer) => {
		peers.add(peer);
		peer.once("close", () => peers.delete(peer));
		attachJsonlLineReader(peer, (line) => {
			const command = JSON.parse(line) as { type: string; id: string };
			const send = (record: Record<string, unknown>) => peer.write(`${JSON.stringify(record)}\n`);
			const reply = (data: Record<string, unknown>) =>
				send({ type: "response", id: command.id, command: command.type, success: true, data });
			if (command.type === "list_sessions")
				reply({
					sessions: [{ sessionId: "rpc-1", cwd: dir, sessionPath: join(dir, "session.jsonl"), status: "open" }],
				});
			else if (command.type === "open_session") reply({ sessionId: "rpc-1", state: {} });
			else if (command.type === "get_state") onState(++stateReads, send, reply, peer);
			else throw new Error(`Unexpected wire request ${command.type}`);
		});
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	closeWires.push(async () => {
		for (const peer of peers) peer.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	return { target: { socket, agentDir: dir }, stateReads: () => stateReads };
}
