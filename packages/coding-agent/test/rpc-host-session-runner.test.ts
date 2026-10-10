import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostEnsure from "../src/modes/rpc/host-ensure.ts";
import { DEFAULT_HOST_LAUNCH_SPEC } from "../src/modes/rpc/host-launch-spec.ts";
import { readHostStatus } from "../src/modes/rpc/host-status.ts";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import { mapError, resolveSessionRow, runHostSessionRequest } from "../src/modes/rpc/host-session-runner.ts";
import { RpcClient, type RpcClientEvent, RpcCommandError, RpcTransportGoneError } from "../src/modes/rpc/rpc-client.ts";
import { type FakeModelServer, startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { HeldAnthropicModel, supervisorLaunch } from "./helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";
import { hostCliSandbox, sweepHostCliSandboxes } from "./suite/host-cli-support.ts";

const dirs: string[] = [];
const clients: RpcClient[] = [];
const models: (FakeModelServer | HeldAnthropicModel)[] = [];
const closeWires: (() => Promise<void>)[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hs-unit-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const close of closeWires.splice(0)) await close();
	for (const client of clients.splice(0)) await client.stop();
	await sweepHostCliSandboxes();
	for (const model of models.splice(0)) {
		if (model instanceof HeldAnthropicModel) model.release();
		await model.close();
	}
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 120_000);

async function rig(held = false) {
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
		env: { SENPI_CODING_AGENT_DIR: qa.agentDir, SENPI_RUNTIME: "node", PI_OFFLINE: "1", PI_TELEMETRY: "0" },
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

function nextEvent(client: RpcClient, type: RpcClientEvent["type"]): Promise<RpcClientEvent> {
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
async function wireRig(
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

// #3073: callers distinguish refusal, caller error and broken transport without scraping prose.
describe("host session runner", () => {
	it("waits for a real settled run and answers an already idle session", async () => {
		const { target, ref, fake } = await rig(true);
		await runHostSessionRequest({ action: "prompt", target, ref, text: "unique-600" });
		await runHostSessionRequest({ action: "steer", target, ref, text: "unique-601" });
		const snapshotted = Promise.withResolvers<void>();
		const getState = RpcClient.prototype.getState;
		vi.spyOn(RpcClient.prototype, "getState").mockImplementation(async function (this: RpcClient) {
			const state = await getState.call(this);
			snapshotted.resolve();
			return state;
		});
		const waiting = runHostSessionRequest({ action: "wait", target, ref, until: "done", timeoutMs: 20_000 });
		await snapshotted.promise;
		if (fake instanceof HeldAnthropicModel) fake.release();
		expect(await waiting).toMatchObject({
			exitCode: 0,
			payload: { action: "wait", outcome: "done", state: { isStreaming: false } },
		});
		expect(
			await runHostSessionRequest({ action: "wait", target, ref, until: "idle", timeoutMs: 20_000 }),
		).toMatchObject({ exitCode: 0, payload: { outcome: "already_idle" } });
	}, 120_000);

	it("does not miss settlement delivered before the initial state reply", async () => {
		const idle = { isStreaming: false, steering: [], followUp: [], ordered: [], pendingMessageCount: 0 };
		const wire = await wireRig((call, send, reply) => {
			if (call === 1) send({ type: "agent_settled", sessionId: "rpc-1" });
			reply(idle);
		});
		expect(
			await runHostSessionRequest({
				action: "wait",
				target: wire.target,
				ref: "rpc-1",
				until: "done",
				timeoutMs: 1000,
			}),
		).toMatchObject({ exitCode: 0, payload: { outcome: "done" } });
		expect(wire.stateReads()).toBe(2);
	});

	it("checks queues once per idle event and ignores low-level run and turn endings", async () => {
		const wire = await wireRig((call, send, reply) => {
			reply({
				isStreaming: call === 1,
				steering: call === 2 ? ["queued"] : [],
				followUp: [],
				ordered: [],
				pendingMessageCount: call === 2 ? 1 : 0,
			});
			if (call === 1) {
				send({ type: "turn_end", sessionId: "rpc-1" });
				send({ type: "agent_end", sessionId: "rpc-1" });
				send({ type: "agent_settled", sessionId: "rpc-1" });
			}
			if (call < 3) send({ type: "agent_idle", sessionId: "rpc-1" });
		});
		expect(
			await runHostSessionRequest({
				action: "wait",
				target: wire.target,
				ref: "rpc-1",
				until: "idle",
				timeoutMs: 1000,
			}),
		).toMatchObject({ exitCode: 0, payload: { outcome: "idle" } });
		expect(wire.stateReads()).toBe(3);
	});

	it.each(["session_closed", "session_parked", "synthetic_settle"])(
		"reports terminal %s without reading a dead session",
		async (kind) => {
			const wire = await wireRig((_call, send) => {
				send(
					kind === "synthetic_settle"
						? { type: "agent_settled", sessionId: "rpc-1", reason: "session_closed" }
						: { type: kind, sessionId: "rpc-1", reason: "host_shutdown" },
				);
			});
			expect(
				await runHostSessionRequest({
					action: "wait",
					target: wire.target,
					ref: "rpc-1",
					until: "done",
					timeoutMs: 1000,
				}),
			).toMatchObject({ exitCode: 0, payload: { outcome: kind === "synthetic_settle" ? "session_closed" : kind } });
		},
	);

	it("reports a lost transport instead of waiting for its deadline", async () => {
		const wire = await wireRig((_call, _send, _reply, socket) => socket.destroy());
		expect(
			await runHostSessionRequest({
				action: "wait",
				target: wire.target,
				ref: "rpc-1",
				until: "done",
				timeoutMs: 1000,
			}),
		).toMatchObject({ exitCode: 1, payload: { reason: "transport_gone" } });
	});

	it("times out a held turn and leaves it available to abort", async () => {
		const { target, ref } = await rig(true);
		await runHostSessionRequest({ action: "prompt", target, ref, text: "held timeout" });
		expect(await runHostSessionRequest({ action: "wait", target, ref, until: "done", timeoutMs: 10 })).toMatchObject({
			exitCode: 1,
			payload: { reason: "wait_timeout", timeoutMs: 10 },
		});
		expect(await runHostSessionRequest({ action: "abort", target, ref })).toMatchObject({ exitCode: 0 });
	}, 120_000);

	it("reads append-order cursors, tails, context messages, state and observe-only listings", async () => {
		const { client, opened, target, ref } = await rig();
		await client.openSession({ sessionPath: String(opened.payload.sessionPath) });
		const idle = nextEvent(client, "agent_idle");
		await client.prompt("unique-313 read-me");
		await idle;
		const read = (options: { tail?: number; since?: string; messages?: boolean } = {}) =>
			runHostSessionRequest({ action: "read", target, ref, messages: false, ...options });
		const all = await read();
		expect(all.exitCode).toBe(0);
		const entries = all.payload.entries as { id: string }[];
		expect(entries.length).toBeGreaterThanOrEqual(3);
		expect(all.payload).toMatchObject({ total: entries.length, count: entries.length, leafId: expect.any(String) });
		expect((await read({ tail: 2 })).payload).toMatchObject({
			entries: entries.slice(-2),
			count: 2,
			nextSince: entries.at(-1)?.id,
		});
		expect((await read({ tail: entries.length + 1 })).payload.entries).toEqual(entries);
		const middle = Math.floor(entries.length / 2);
		expect((await read({ since: entries[middle].id })).payload.entries).toEqual(entries.slice(middle + 1));
		expect((await read({ since: entries[middle].id, tail: 1 })).payload.entries).toEqual(entries.slice(-1));
		expect((await read({ since: entries.at(-1)?.id })).payload).toMatchObject({
			count: 0,
			nextSince: entries.at(-1)?.id,
		});
		expect(JSON.stringify((await read({ messages: true })).payload.messages)).toContain("unique-313 read-me");
		expect((await read({ messages: true, tail: 1 })).payload.count).toBe(1);
		expect(await read({ since: "nope" })).toMatchObject({ exitCode: 3, payload: { reason: "unknown_cursor" } });
		expect(await runHostSessionRequest({ action: "state", target, ref })).toMatchObject({
			exitCode: 0,
			payload: {
				durableSessionId: opened.payload.durableSessionId,
				state: { isStreaming: false, sessionId: opened.payload.durableSessionId },
			},
		});
		const before = (await readHostStatus(target)).sessions;
		expect((await runHostSessionRequest({ action: "list", target })).payload.sessions).toEqual([
			expect.objectContaining({ sessionId: ref, attachments: 1 }),
		]);
		expect((await readHostStatus(target)).sessions).toEqual(before);
		expect(await runHostSessionRequest({ action: "read", target, ref: "unknown", messages: false })).toMatchObject({
			exitCode: 3,
			payload: { reason: "unknown_session" },
		});
	}, 120_000);

	it("reports busy prompts, queued steering and idle steering without starting a turn", async () => {
		const { client, opened, target, ref, fake } = await rig(true);
		await client.openSession({ sessionPath: String(opened.payload.sessionPath) });
		expect(await runHostSessionRequest({ action: "prompt", target, ref, text: "unique-1" })).toMatchObject({
			exitCode: 0,
			payload: { disposition: "started" },
		});
		expect(await runHostSessionRequest({ action: "prompt", target, ref, text: "busy" })).toMatchObject({
			exitCode: 3,
			payload: { reason: "busy" },
		});
		expect(await runHostSessionRequest({ action: "steer", target, ref, text: "unique-2" })).toMatchObject({
			exitCode: 0,
			payload: { disposition: "queued", streaming: true },
		});
		const idle = nextEvent(client, "agent_idle");
		if (fake instanceof HeldAnthropicModel) fake.release();
		await idle;
		expect(await runHostSessionRequest({ action: "steer", target, ref, text: "parked" })).toMatchObject({
			exitCode: 0,
			payload: { disposition: "queued", streaming: false },
		});
		expect(await client.getSteeringMessages()).toEqual(["parked"]);
		expect((await client.getState()).isStreaming).toBe(false);
	}, 120_000);

	it("acknowledges aborts and changes models both mid-turn and idle", async () => {
		const { client, opened, target, ref } = await rig(true);
		await client.openSession({ sessionPath: String(opened.payload.sessionPath) });
		await runHostSessionRequest({ action: "prompt", target, ref, text: "stop-me" });
		expect(
			await runHostSessionRequest({
				action: "model",
				target,
				ref,
				model: { provider: "anthropic", id: "mock-claude-rpc-2" },
			}),
		).toMatchObject({ exitCode: 0, payload: { model: { id: "mock-claude-rpc-2" }, pendingModelSwitch: null } });
		const ended = nextEvent(client, "agent_end");
		const idle = nextEvent(client, "agent_idle");
		expect(await runHostSessionRequest({ action: "abort", target, ref })).toMatchObject({
			exitCode: 0,
			payload: { acknowledged: true, aborted: true },
		});
		expect(await ended).toMatchObject({ aborted: true, abortSource: "user" });
		await idle;
		expect(await runHostSessionRequest({ action: "abort", target, ref })).toMatchObject({
			exitCode: 0,
			payload: { aborted: false },
		});
		expect(
			await runHostSessionRequest({
				action: "model",
				target,
				ref,
				model: { provider: "anthropic", id: "mock-claude-rpc" },
			}),
		).toMatchObject({ exitCode: 0, payload: { model: { id: "mock-claude-rpc" } } });
		expect(
			await runHostSessionRequest({ action: "model", target, ref, model: { provider: "anthropic", id: "nope" } }),
		).toMatchObject({ exitCode: 3, payload: { reason: "model_not_found" } });
	}, 120_000);

	it("opens a retained named session and releases its client attachment", async () => {
		const { opened, client, ref } = await rig();
		expect(ref).toMatch(/^rpc-\d+$/);
		expect(isAbsolute(String(opened.payload.sessionPath))).toBe(true);
		expect(opened.payload).toMatchObject({
			durableSessionId: expect.any(String),
			model: { id: "mock-claude-rpc" },
			attached: false,
		});
		expect(await client.listSessions()).toEqual([
			expect.objectContaining({ sessionId: ref, attachments: 0, status: "open", name: "lane-1" }),
		]);
	}, 120_000);

	it("releases the ensure hold after a refused open", async () => {
		const { client, target, spec } = await rig();
		const before = await client.listSessions();
		const result = await runHostSessionRequest({ action: "open", target, spec, cwd: "relative" });
		expect(result).toMatchObject({ exitCode: 2, payload: { action: "error", reason: "invalid_path" } });
		expect(await client.listSessions()).toHaveLength(before.length);
	}, 120_000);

	it("refuses an unavailable host without starting one", async () => {
		const agentDir = scratch();
		expect(
			await runHostSessionRequest({ action: "list", target: { agentDir, socket: join(agentDir, "absent.sock") } }),
		).toMatchObject({ exitCode: 3, payload: { action: "refuse", reason: "host_unavailable" } });
	});

	it("rejects a terminal endpoint before connecting", async () => {
		const agentDir = scratch();
		expect(
			await runHostSessionRequest({
				action: "list",
				target: { agentDir, socket: join(agentDir, "t-0123456789abcdef.sock") },
			}),
		).toMatchObject({ exitCode: 3, payload: { reason: "unsupported_endpoint_kind" } });
	});

	it.each([
		["unknown_session", "unknown_session", 3],
		["future_code", "future_code", 3],
		["invalid_path", "invalid_path", 2],
		["open_failed", "open_failed", 1],
		["invalid_path", undefined, 2],
		["open_failed: unavailable", undefined, 1],
		["Model not found: a/b", undefined, 3],
		["Entry not found: x", undefined, 3],
		["Agent is already processing a prompt", undefined, 3],
	] as const)("maps host response %s", (message, code, exitCode) => {
		const reason =
			code ??
			(message.startsWith("Model")
				? "model_not_found"
				: message.startsWith("Entry")
					? "unknown_cursor"
					: message.startsWith("Agent")
						? "busy"
						: message.split(":")[0]);
		const data = { holders: [{ pid: 42 }] };
		expect(mapError(new RpcCommandError(message, code, data), "/rpc.sock")).toEqual({
			exitCode,
			payload: { action: exitCode === 3 ? "refuse" : "error", reason, detail: message, data, socket: "/rpc.sock" },
		});
	});

	it("classifies lost transport separately from host refusals", () => {
		expect(mapError(new RpcTransportGoneError(), "/rpc.sock")).toMatchObject({
			exitCode: 1,
			payload: { action: "error", reason: "transport_gone" },
		});
	});

	it("resolves routing ids before durable ids, names and canonical paths", async () => {
		const dir = scratch();
		const path = join(dir, "session.jsonl");
		writeFileSync(path, "");
		const alias = join(dir, "alias.jsonl");
		symlinkSync(path, alias);
		const row = {
			sessionId: "rpc-1",
			durableSessionId: "durable",
			name: "lane",
			sessionPath: path,
			cwd: dir,
			status: "open" as const,
		};
		const client = { listSessions: async () => [row] };
		for (const ref of ["rpc-1", "durable", "lane", path, alias])
			expect(await resolveSessionRow(client, ref)).toBe(row);
		expect(await resolveSessionRow(client, "missing")).toBeUndefined();
	});
});
