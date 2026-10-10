import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { MOCK_API_KEY, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import {
	type HostCliSandbox,
	hostCliSandbox,
	onlyJsonLine,
	runHostCli,
	sweepHostCliSandboxes,
} from "./host-cli-support.ts";

const cleanups: (() => Promise<void>)[] = [];
const execute = promisify(execFile);

afterEach(async () => {
	await sweepHostCliSandboxes();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 120_000);

/**
 * Gate the real fake-model HTTP requests, not elapsed time. A loaded CI runner may take
 * arbitrarily long to launch the steer/abort CLI without losing its mid-turn window.
 */
async function gatedModel() {
	const fake = await startFakeModelServer();
	cleanups.push(() => fake.close());
	let held = true;
	const pending: (() => void)[] = [];
	const server = createHttpServer((req, res) => {
		const forward = () => {
			if (res.destroyed) return;
			const upstream = httpRequest(
				`${fake.origin}${req.url}`,
				{ method: req.method, headers: req.headers },
				(reply) => {
					res.writeHead(reply.statusCode ?? 500, reply.headers);
					reply.pipe(res);
				},
			);
			upstream.on("error", () => res.destroy());
			res.once("close", () => upstream.destroy());
			req.pipe(upstream);
		};
		if (held) pending.push(forward);
		else forward();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	return {
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		hold: () => {
			held = true;
		},
		release: () => {
			held = false;
			for (const forward of pending.splice(0)) forward();
		},
	};
}

/**
 * Relay the wait CLI's unmodified RPC stream. Release the model only after the host
 * answers wait's initial snapshot: the CLI has subscribed by then. This is an event
 * barrier over real processes, not a mocked session or a startup sleep.
 */
async function waitEndpoint(qa: HostCliSandbox, release: () => void): Promise<HostCliSandbox> {
	const socket = join(qa.root, "wait.sock");
	const peers = new Set<Socket>();
	const server = createServer((peer) => {
		const upstream = createConnection(qa.socket);
		peers.add(peer);
		peers.add(upstream);
		let stateRequest: string | undefined;
		attachJsonlLineReader(peer, (line) => {
			const command = JSON.parse(line) as { id?: string; type: string };
			if (command.type === "get_state") stateRequest = command.id;
		});
		attachJsonlLineReader(upstream, (line) => {
			const response = JSON.parse(line) as { id?: string; type: string };
			if (response.type === "response" && response.id === stateRequest) {
				stateRequest = undefined;
				release();
			}
		});
		peer.pipe(upstream).pipe(peer);
		peer.on("error", () => upstream.destroy());
		upstream.on("error", () => peer.destroy());
		peer.once("close", () => {
			peers.delete(peer);
			upstream.destroy();
		});
		upstream.once("close", () => {
			peers.delete(upstream);
			peer.destroy();
		});
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	cleanups.push(async () => {
		for (const peer of peers) peer.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	return { ...qa, socket };
}

// #3073: every operation crosses the source CLI process boundary against a real daemon.
describe("senpi host session process contract", () => {
	it("opens, drives, waits, reads and closes a retained session without leaking work", async () => {
		const qa = await hostCliSandbox("session-cli");
		const cwd = join(qa.root, "work");
		await mkdir(cwd);
		const model = await gatedModel();
		writeRpcModelsJson(qa.agentDir, model.origin, ["mock-claude-rpc-2"]);
		const command = async (args: string[], code = 0, endpoint = qa) => {
			const result = await runHostCli(endpoint, ["session", ...args], { ANTHROPIC_API_KEY: MOCK_API_KEY });
			expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(code);
			return onlyJsonLine(result);
		};

		const opened = await command(["open", "--cwd", cwd, "--model", "anthropic/mock-claude-rpc", "--name", "it-lane"]);
		expect(opened).toMatchObject({
			action: "open",
			sessionId: expect.any(String),
			durableSessionId: expect.any(String),
			sessionPath: expect.any(String),
			reused: false,
		});
		const ref = String(opened.sessionId);
		expect((await command(["list"])).sessions).toEqual([
			expect.objectContaining({ sessionId: ref, attachments: 0, name: "it-lane", status: "open" }),
		]);
		expect(await command(["prompt", ref, "unique-11"])).toMatchObject({ disposition: "started" });
		expect(await command(["prompt", ref, "busy prompt"], 3)).toMatchObject({ reason: "busy" });
		expect(await command(["steer", ref, "unique-22 mid"])).toMatchObject({ streaming: true, disposition: "queued" });
		const waitQa = await waitEndpoint(qa, model.release);
		expect(await command(["wait", ref, "--until", "idle", "--timeout", "30000"], 0, waitQa)).toMatchObject({
			outcome: "idle",
		});
		const messages = await command(["read", ref, "--messages"]);
		expect(JSON.stringify(messages.messages)).toContain("unique-11");
		expect(JSON.stringify(messages.messages)).toContain("unique-22 mid");
		const firstRead = await command(["read", ref]);
		const cursor = String(firstRead.nextSince);

		model.hold();
		expect(await command(["prompt", ref, "stop-me"])).toMatchObject({ disposition: "started" });
		expect(await command(["wait", ref, "--until", "done", "--timeout", "100"], 1)).toMatchObject({
			reason: "wait_timeout",
		});
		expect(await command(["abort", ref])).toMatchObject({ acknowledged: true, aborted: true });
		expect(["idle", "already_idle"]).toContain((await command(["wait", ref, "--until", "idle"])).outcome);
		expect(await command(["abort", ref])).toMatchObject({ aborted: false });
		expect(await command(["model", ref, "anthropic/mock-claude-rpc-2"])).toMatchObject({
			model: { id: "mock-claude-rpc-2" },
		});
		expect(await command(["state", String(opened.durableSessionId)])).toMatchObject({
			state: { model: { id: "mock-claude-rpc-2" }, isStreaming: false },
		});
		expect(await command(["read", String(opened.sessionPath), "--tail", "3"])).toMatchObject({ count: 3 });
		const since = await command(["read", ref, "--since", cursor]);
		expect(since.count).toBeGreaterThan(0);
		expect((since.entries as { id: string }[]).some((entry) => entry.id === cursor)).toBe(false);
		expect(await command(["steer", ref, "idle-steer"])).toMatchObject({ streaming: false });
		expect(await command(["close", ref])).toMatchObject({ closed: true });
		expect(await command(["list"])).toMatchObject({ sessions: [] });
		const statusResult = await runHostCli(qa, ["status"]);
		expect(statusResult.exitCode).toBe(0);
		const status = onlyJsonLine(statusResult);
		expect(status).toMatchObject({ sessions: { total: 0 } });
		// The supervisor still owns the daemon; no session-owned descendant remains.
		const hostPid = (await execute("pgrep", ["-P", String(status.pid)])).stdout.trim();
		expect(hostPid).toMatch(/^\d+$/);
		await expect(execute("pgrep", ["-P", hostPid])).rejects.toMatchObject({ code: 1, stdout: "" });
		expect(await command(["state", "nope"], 3)).toMatchObject({ action: "refuse", reason: "unknown_session" });
		expect(await command(["list"], 3, { ...qa, socket: join(qa.root, "missing.sock") })).toMatchObject({
			action: "refuse",
			reason: "host_unavailable",
		});
	}, 120_000);
});
