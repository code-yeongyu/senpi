import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import {
	contextHost,
	identitySchema,
	listedSchema,
	PROBE_EXTENSION,
	responseData,
} from "./rpc-session-context-support.ts";
import { startInProcessHost } from "./rpc-worker-host-support.ts";

it("gives each session's extension exactly the kind and context that opened it", async () => {
	// Given: one host serving two worker sessions with different contexts and one plain open.
	await using host = await contextHost();

	// When: each session's own extension instance reports the identity it was loaded with.
	const child = await host.open("conn-a", { kind: "worker", context: { role: "child", task_id: "t1" } });
	const member = await host.open("conn-a", { kind: "worker", context: { role: "member", member: "m1" } });
	const plain = await host.open("conn-a", {});

	// Then: no session sees another's context, and an absent kind/context is the default.
	expect(await host.probe("conn-a", String(child.sessionId))).toEqual({
		kind: "worker",
		context: { role: "child", task_id: "t1" },
	});
	expect(await host.probe("conn-a", String(member.sessionId))).toEqual({
		kind: "worker",
		context: { role: "member", member: "m1" },
	});
	expect(await host.probe("conn-a", String(plain.sessionId))).toEqual({ kind: "interactive", context: {} });
}, 120_000);

it("omits worker rows and every context from a default list_sessions", async () => {
	// Given: two worker sessions and one interactive session on one host.
	await using host = await contextHost();
	const child = await host.open("conn-a", { kind: "worker", context: { role: "child" } });
	const member = await host.open("conn-a", { kind: "worker", context: { role: "member" } });
	const interactive = await host.open("conn-a", {});

	// When: a client lists sessions without asking for workers.
	const listed = await host.list("conn-a");

	// Then: only the interactive row is published, and no row carries context.
	expect(listed.map((row) => row.sessionId)).toEqual([interactive.sessionId]);
	expect(listed.map((row) => row.kind)).toEqual(["interactive"]);
	expect(listed.every((row) => row.context === undefined)).toBe(true);
	expect(listed.map((row) => row.sessionId)).not.toContain(child.sessionId);
	expect(listed.map((row) => row.sessionId)).not.toContain(member.sessionId);
}, 120_000);

it("lists worker rows with their kind and context for include_workers", async () => {
	// Given: the same two worker sessions and one interactive session.
	await using host = await contextHost();
	const child = await host.open("conn-a", { kind: "worker", context: { role: "child", task_id: "t1" } });
	const member = await host.open("conn-a", { kind: "worker", context: { role: "member", member: "m1" } });
	const interactive = await host.open("conn-a", {});

	// When: a client opts into worker visibility.
	const listed = await host.list("conn-a", true);

	// Then: every session is published with its kind and its own context.
	expect(listed).toEqual([
		expect.objectContaining({
			sessionId: child.sessionId,
			kind: "worker",
			context: { role: "child", task_id: "t1" },
		}),
		expect.objectContaining({
			sessionId: member.sessionId,
			kind: "worker",
			context: { role: "member", member: "m1" },
		}),
		expect.objectContaining({ sessionId: interactive.sessionId, kind: "interactive", context: {} }),
	]);
}, 120_000);

it("keeps a worker session hidden when a later open attaches to it without a kind", async () => {
	// Given: a worker session another connection can reach by path.
	await using host = await contextHost();
	const sessionPath = join(host.scratch, "attached-worker.jsonl");
	const worker = await host.open("conn-a", { kind: "worker", sessionPath, context: { role: "child" } });

	// When: a second connection attaches to that path with no kind and no context of its own.
	const attached = await host.open("conn-b", { sessionPath });
	expect(attached.attached).toBe(true);
	expect(attached.sessionId).toBe(worker.sessionId);

	// Then: the attach cannot downgrade the live session's visibility or replace its context.
	expect(await host.list("conn-b")).toEqual([]);
	expect(await host.list("conn-b", true)).toEqual([
		expect.objectContaining({ sessionId: worker.sessionId, kind: "worker", context: { role: "child" } }),
	]);
	expect(await host.probe("conn-b", String(worker.sessionId))).toEqual({
		kind: "worker",
		context: { role: "child" },
	});
}, 120_000);

it("delivers a worker session's session_closed only to the connections attached to it", async () => {
	// Given: a worker session two connections are attached to, and a third connection that is not.
	await using host = await contextHost({ idleEvictionMs: 1_000 });
	const worker = await host.open("conn-a", {
		kind: "worker",
		sessionPath: join(host.scratch, "worker.jsonl"),
		context: { role: "child" },
	});
	const attached = await host.open("conn-b", { sessionPath: join(host.scratch, "worker.jsonl") });
	expect(attached.sessionId).toBe(worker.sessionId);
	host.connect("conn-c");

	// When: the host itself closes that session through its occupancy sweep.
	await host.evictIdle(String(worker.sessionId));

	// Then: both attached connections learn; the unattached one never sees the worker session.
	const closedFor = (connection: string) =>
		host
			.inbox(connection)
			.filter((record) => record.type === "session_closed" && record.sessionId === worker.sessionId);
	expect(closedFor("conn-a")).toEqual([
		{ type: "session_closed", sessionId: worker.sessionId, reason: "idle_evicted" },
	]);
	expect(closedFor("conn-b")).toEqual([
		{ type: "session_closed", sessionId: worker.sessionId, reason: "idle_evicted" },
	]);
	expect(closedFor("conn-c")).toEqual([]);
}, 120_000);

it("keeps an interactive session's session_closed broadcast to every connection", async () => {
	// Given: an interactive session one connection opened, and a second connection attached to nothing.
	await using host = await contextHost({ idleEvictionMs: 1_000 });
	const interactive = await host.open("conn-a", {});
	host.connect("conn-c");

	// When: the host closes it through the same sweep.
	await host.evictIdle(String(interactive.sessionId));

	// Then: the observer connection still receives the lifecycle record (desktop mirror unchanged).
	expect(
		host
			.inbox("conn-c")
			.filter((record) => record.type === "session_closed" && record.sessionId === interactive.sessionId),
	).toEqual([{ type: "session_closed", sessionId: interactive.sessionId, reason: "idle_evicted" }]);
}, 120_000);

it("refuses a context past the key, value or total byte caps", async () => {
	// Given: a host and three contexts that each break one documented cap.
	await using host = await contextHost();
	const keys = Object.fromEntries(Array.from({ length: 33 }, (_value, index) => [`k${index}`, "v"]));
	const total = Object.fromEntries(Array.from({ length: 4 }, (_value, index) => [`k${index}`, "x".repeat(10 * 1024)]));

	// When/Then: each is refused with the stable code, and the value cap names its byte budget.
	expect(await host.openFailure("conn-a", { kind: "worker", context: keys })).toMatch(/^invalid_session_context: /);
	expect(await host.openFailure("conn-a", { kind: "worker", context: total })).toMatch(/^invalid_session_context: /);
	expect(await host.openFailure("conn-a", { kind: "worker", context: { blob: "x".repeat(20 * 1024) } })).toMatch(
		/^invalid_session_context: .*16384/,
	);
	expect(await host.openFailure("conn-a", { context: { "Bad-Key": "v" } })).toMatch(/^invalid_session_context: /);
}, 120_000);

it("refuses an unrecognized kind instead of treating it as interactive", async () => {
	// Given: a client that misspells the visibility class it wants.
	await using host = await contextHost();

	// When/Then: the open is refused, so a typo can never publish machine-driven work.
	expect(await host.openFailure("conn-a", { kind: "Worker" })).toMatch(/^invalid_session_kind: /);
	expect(await host.list("conn-a", true)).toEqual([]);
}, 120_000);

it("advertises session_context and session_kind in get_protocol_info", async () => {
	await using host = await contextHost();
	const data = responseData(await host.send("conn-a", { type: "get_protocol_info" }));
	expect(z.array(z.string()).parse(data.capabilities)).toEqual(
		expect.arrayContaining(["multi_session", "session_context", "session_kind"]),
	);
}, 120_000);

it("carries kind and context across a real socket host", async () => {
	// Given: a socket host on its default (in-process) runtime with the probe extension.
	const host = await startInProcessHost(PROBE_EXTENSION);
	try {
		const client = await host.connect();
		const worker = responseData(
			await client.request({
				type: "open_session",
				cwd: host.cwd,
				kind: "worker",
				context: { role: "child", task_id: "t1" },
			}),
		);
		const interactive = responseData(await client.request({ type: "open_session", cwd: host.cwd }));
		// A socket host stamps its own endpoint and generation over every session's context.
		const stamped = {
			host_socket: expect.stringMatching(/\/rpc\.sock$/),
			host_instance: responseData(await client.request({ type: "get_protocol_info" })).instanceId,
		};

		// When/Then: the wire carries both fields end to end.
		expect(
			identitySchema.parse(
				responseData(
					await client.request({
						type: "extension_request",
						name: "probe.identity",
						sessionId: worker.sessionId,
					}),
				),
			),
		).toEqual({ kind: "worker", context: { role: "child", task_id: "t1", ...stamped } });
		expect(
			z.array(listedSchema).parse(responseData(await client.request({ type: "list_sessions" })).sessions),
		).toEqual([expect.objectContaining({ sessionId: interactive.sessionId, kind: "interactive" })]);
		expect(
			z
				.array(listedSchema)
				.parse(responseData(await client.request({ type: "list_sessions", include_workers: true })).sessions)
				.map((row) => ({ kind: row.kind, context: row.context })),
		).toEqual([
			{ kind: "worker", context: { role: "child", task_id: "t1", ...stamped } },
			{ kind: "interactive", context: stamped },
		]);
		const refused = await client.request({
			type: "open_session",
			cwd: host.cwd,
			context: { blob: "x".repeat(20 * 1024) },
		});
		expect(refused.success).toBe(false);
		expect(refused.error).toMatch(/^invalid_session_context: .*16384/);
	} finally {
		await host.dispose();
	}
}, 600_000);

// The shared endpoint schema types `data.state` as a session snapshot and `message` as text; a warm and a model
// turn send neither, so this case reads the socket's JSON lines itself.
type RawRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };
async function rawClient(socketPath: string) {
	const socket = createConnection(socketPath);
	await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
	const records: RawRecord[] = [];
	const waiters = new Set<(record: RawRecord) => void>();
	createInterface({ input: socket }).on("line", (line) => {
		const record = z.record(z.string(), z.unknown()).parse(JSON.parse(line)) as RawRecord;
		records.push(record);
		for (const waiter of [...waiters]) waiter(record);
	});
	let serial = 0;
	const wait = (predicate: (record: RawRecord) => boolean, ms = 60_000): Promise<RawRecord> =>
		new Promise((resolve, reject) => {
			const seen = records.find(predicate);
			if (seen) return resolve(seen);
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error(`deadline waiting on the socket: ${String(predicate).slice(0, 120)}`));
			}, ms);
			const waiter = (record: RawRecord): void => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				waiters.delete(waiter);
				resolve(record);
			};
			waiters.add(waiter);
		});
	return {
		wait,
		send(command: Record<string, unknown>): void {
			socket.write(`${JSON.stringify(command)}\n`);
		},
		async request(command: Record<string, unknown>): Promise<RawRecord> {
			const id = `raw-${++serial}`;
			const response = wait((record) => record.type === "response" && record.id === id);
			socket.write(`${JSON.stringify({ ...command, id })}\n`);
			return response;
		},
		close(): void {
			socket.destroy();
		},
	};
}

it("applies each session's permission preset on a warmed socket host (#2461)", async () => {
	// Given: a socket host whose sessions load a faux model scripted to read a file outside the project.
	const outside = join(tmpdir(), `senpi-2461-outside-${process.pid}`);
	await mkdir(outside, { recursive: true });
	await writeFile(join(outside, "secret.txt"), "outside secret\n");
	const faux = pathToFileURL(fileURLToPath(new URL("../../../ai/dist/providers/faux.js", import.meta.url))).href;
	const host =
		await startInProcessHost(`import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(faux)};
export default function (pi) {
	const faux = fauxProvider({ api: "fauxsock", provider: "fauxsock" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: ${JSON.stringify(join(outside, "secret.txt"))} }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	pi.registerProvider(faux.provider);
}`);
	try {
		const client = await rawClient(host.socketPath);
		const warmed = await client.request({ type: "warm", cwd: host.cwd });
		expect((warmed.data as { state?: unknown } | undefined)?.state).toBe("warmed");

		// When: one session per preset opens after the warm and runs the scripted turn, denying any prompt.
		const turn = async (permissionPreset: string) => {
			const opened = await client.request({
				type: "open_session",
				cwd: host.cwd,
				permissionPreset,
				provider: "fauxsock",
				modelId: "faux-1",
			});
			const sessionId = String((opened.data as { sessionId?: unknown } | undefined)?.sessionId);
			const asked: string[] = [];
			// Settles on the turn's idle; a permission prompt on the way is recorded and denied.
			const idle = client.wait((record) => {
				if (record.sessionId !== sessionId) return false;
				if (record.type === "extension_ui_request" && record.method === "select") {
					asked.push(String(record.title).split("\n")[0]);
					client.send({ type: "extension_ui_response", sessionId, id: record.id, value: "Deny" });
					return false;
				}
				return record.type === "agent_idle";
			}, 60_000);
			const ended = client.wait(
				(record) => record.type === "tool_execution_end" && record.sessionId === sessionId,
				60_000,
			);
			await client.request({ type: "prompt", sessionId, message: "go" });
			const end = await ended;
			await idle;
			return { asked, result: JSON.stringify(end) };
		};

		// Then: accept-edits asks and never returns the file; full-access reads it with no prompt.
		const guarded = await turn("accept-edits");
		expect(guarded.asked).toEqual(["Permission required: external_directory"]);
		expect(guarded.result).not.toContain("outside secret");
		const open = await turn("full-access");
		expect(open.asked).toEqual([]);
		expect(open.result).toContain("outside secret");
		client.close();
	} finally {
		await host.dispose();
		await rm(outside, { recursive: true, force: true });
	}
}, 600_000);

it("titles a session that set auto_title true on a host started without the flag", async () => {
	// Given: a host with no --auto-title-sessions and a faux model that answers turns and titles.
	await using host = await contextHost({ titleModel: true });
	const opened = await host.open("conn-a", { auto_title: true, sessionPath: join(host.scratch, "a.jsonl") });
	const sessionId = String(opened.sessionId);

	// When: that session completes its first turn.
	await host.prompt("conn-a", sessionId, "fix the RPC session title pipeline");

	// Then: the engine generated a title and published it.
	expect(
		host.inbox("conn-a").find((record) => record.type === "session_info_changed" && record.sessionId === sessionId),
	).toMatchObject({ name: "Generated Title" });
}, 120_000);

it("does not title a session that omitted auto_title on a host started without the flag", async () => {
	// Given: the same host default, and a session that did not set auto_title.
	await using host = await contextHost({ titleModel: true });
	const opened = await host.open("conn-a", { sessionPath: join(host.scratch, "b.jsonl") });
	const sessionId = String(opened.sessionId);

	// When: that session completes its first turn.
	await host.prompt("conn-a", sessionId, "fix the RPC session title pipeline");

	// Then: the host-wide default (off) applies, so no title call and no event.
	expect(
		host.inbox("conn-a").filter((record) => record.type === "session_info_changed" && record.sessionId === sessionId),
	).toEqual([]);
	expect(host.faux?.getCallLog()).toHaveLength(1);
}, 120_000);

it("does not title a session that set auto_title false on a host started with the flag", async () => {
	// Given: a host started WITH --auto-title-sessions, and a session that opts out.
	await using host = await contextHost({ titleModel: true, autoTitleSessions: true });
	const opened = await host.open("conn-a", { auto_title: false, sessionPath: join(host.scratch, "c.jsonl") });
	const sessionId = String(opened.sessionId);

	// When: that session completes its first turn.
	await host.prompt("conn-a", sessionId, "fix the RPC session title pipeline");

	// Then: the per-session false wins over the host flag.
	expect(
		host.inbox("conn-a").filter((record) => record.type === "session_info_changed" && record.sessionId === sessionId),
	).toEqual([]);
	expect(host.faux?.getCallLog()).toHaveLength(1);
}, 120_000);

it("advertises auto_title_per_session in get_protocol_info", async () => {
	await using host = await contextHost();
	const data = responseData(await host.send("conn-a", { type: "get_protocol_info" }));
	expect(z.array(z.string()).parse(data.capabilities)).toEqual(expect.arrayContaining(["auto_title_per_session"]));
}, 120_000);

it("refuses a non-boolean auto_title", async () => {
	await using host = await contextHost();
	expect(await host.openFailure("conn-a", { auto_title: "yes" })).toMatch(/^invalid_launch_profile/);
}, 120_000);

it("refuses a null auto_title instead of treating it as absent", async () => {
	await using host = await contextHost();
	expect(await host.openFailure("conn-a", { auto_title: null })).toMatch(/^invalid_launch_profile/);
}, 120_000);
