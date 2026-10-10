import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHostSessionRequest } from "../../src/modes/rpc/host-session-runner.ts";
import { readHostStatus } from "../../src/modes/rpc/host-status.ts";
import { HeldAnthropicModel, JsonlPeer } from "../helpers/rpc-generation-support.ts";
import { cleanupHostSessionRigs, nextEvent, rig, scratch } from "./host-session-support.ts";

afterEach(cleanupHostSessionRigs, 120_000);

// #3073: callers distinguish refusal, caller error and broken transport without scraping prose.
describe("host session runner", () => {
	it("closes idle sessions and refuses a second close", async () => {
		const { target, ref, client } = await rig();
		expect(await runHostSessionRequest({ action: "close", target, ref })).toMatchObject({
			exitCode: 0,
			payload: { closed: true, reason: "client_close" },
		});
		expect(await client.listSessions()).toEqual([]);
		expect((await readHostStatus(target)).sessions.total).toBe(0);
		expect(await runHostSessionRequest({ action: "close", target, ref })).toMatchObject({
			exitCode: 3,
			payload: { reason: "unknown_session" },
		});
	}, 120_000);

	it("reports another holder instead of force-closing its session", async () => {
		const { target, ref, opened, client } = await rig();
		await client.openSession({ sessionPath: String(opened.payload.sessionPath) });
		expect(await runHostSessionRequest({ action: "close", target, ref })).toMatchObject({
			exitCode: 0,
			payload: { closed: false, attachments: 1 },
		});
		expect(await client.listSessions()).toEqual([expect.objectContaining({ sessionId: ref, attachments: 1 })]);
	}, 120_000);

	it("closes a running turn and leaves no per-session child process", async () => {
		const { target, ref, opened, client } = await rig(true);
		const observer = await JsonlPeer.connect(target.socket);
		try {
			const closed = observer.waitFor((event) => event.type === "session_closed" && event.sessionId === ref);
			await runHostSessionRequest({ action: "prompt", target, ref, text: "close mid-turn" });
			expect(await runHostSessionRequest({ action: "close", target, ref })).toMatchObject({
				exitCode: 0,
				payload: { closed: true },
			});
			expect(await closed).toMatchObject({ reason: "client_close" });
			expect(await client.listSessions()).toEqual([]);
			// status/open report the supervisor, whose one host child is intentional.
			const hostPid = await new Promise<string>((resolve, reject) => {
				execFile("pgrep", ["-P", String(opened.payload.pid)], (error, stdout) =>
					error ? reject(error) : resolve(stdout.trim()),
				);
			});
			expect(hostPid).toMatch(/^\d+$/);
			await new Promise<void>((resolve, reject) => {
				execFile("pgrep", ["-P", hostPid], (error, stdout) => {
					try {
						expect(error?.code).toBe(1);
						expect(stdout).toBe("");
						resolve();
					} catch (failure) {
						reject(failure);
					}
				});
			});
		} finally {
			observer.destroy();
		}
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
		// A parked steer is not idle: `idle` keeps waiting while `done` sees no running turn.
		expect(await runHostSessionRequest({ action: "wait", target, ref, until: "idle", timeoutMs: 100 })).toMatchObject(
			{ exitCode: 1, payload: { reason: "wait_timeout" } },
		);
		expect(
			await runHostSessionRequest({ action: "wait", target, ref, until: "done", timeoutMs: 20_000 }),
		).toMatchObject({ exitCode: 0, payload: { outcome: "already_idle" } });
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
});
