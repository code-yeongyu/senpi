import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrClient, herdrSocketTarget } from "../../src/core/extensions/builtin/herdr/herdr-client.ts";
import { initialHerdrState, reduceHerdrState } from "../../src/core/extensions/builtin/herdr/herdr-state.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	acknowledge,
	cleanupHerdrReporterFixtures,
	herdrReporterFixture,
	scriptedTransport,
} from "./herdr-reporter-harness.ts";

beforeEach(() => {
	vi.useRealTimers();
});
afterEach(async () => {
	await cleanupHerdrReporterFixtures();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("herdr lifecycle reporter (senpi#1645)", () => {
	it("sends the exact ordered lifecycle transcript over NDJSON", async () => {
		const f = await herdrReporterFixture();
		await f.start();
		expect(f.requests.map((r) => r.method)).toEqual([
			"pane.report_metadata",
			"pane.report_agent_session",
			"pane.report_agent",
		]);
		expect(f.requests[0]?.params).toMatchObject({ title: "Reporter QA", display_agent: "Reporter QA" });
		expect(f.requests[1]?.params).toMatchObject({ agent_session_path: "/sessions/root.jsonl" });
		f.setIdle(false);
		await f.emit("agent_start");
		await f.bus("herdr:blocked", { active: true, id: "q1", label: "Auth — Which flow?" });
		expect(f.requests.at(-1)?.params).toMatchObject({ state: "blocked", message: "Auth — Which flow?" });
		await f.bus("herdr:blocked", { active: false, id: "q1" });
		await f.bus("herdr:blocked", { active: false, id: "q1" });
		f.setIdle(true);
		await f.emit("agent_settled");
		await f.emit("session_shutdown", { reason: "quit" });
		await f.emit("session_shutdown", { reason: "quit" });
		expect(f.requests.filter((r) => r.method === "pane.report_agent").map((r) => r.params.state)).toEqual([
			"idle",
			"working",
			"blocked",
			"working",
			"idle",
		]);
		expect(f.requests.filter((r) => r.method === "pane.release_agent")).toHaveLength(1);
		expect(f.requests.at(-1)?.method).toBe("pane.release_agent");
		for (const [index, request] of f.requests.entries()) {
			expect(request.params).toMatchObject({ pane_id: "pane-test", source: "custom:senpi" });
			if (index > 0) expect(request.params.seq).toBeGreaterThan(f.requests[index - 1]!.params.seq);
		}
		if (process.env.HERDR_QA_TRANSCRIPT)
			writeFileSync(process.env.HERDR_QA_TRANSCRIPT, `${f.requests.map((r) => JSON.stringify(r)).join("\n")}\n`);
	});

	it.each(["reload", "new", "resume", "fork"])(
		"silences the old runtime on %s without releasing the pane",
		async (reason) => {
			const f = await herdrReporterFixture();
			await f.start();
			expect(f.requests).toHaveLength(3);
			await f.emit("session_shutdown", { reason });
			await f.emit("agent_start");
			await f.bus("herdr:blocked", { active: true, id: "late", label: "late" });
			await f.bus("terminal_monitor_state", { activeCount: 4 });
			expect(f.requests).toHaveLength(3);
		},
	);

	it.each(["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"])("never connects without %s", async (name) => {
		const f = await herdrReporterFixture();
		vi.stubEnv(name, undefined);
		await f.start();
		await f.emit("agent_start");
		expect(f.connect).not.toHaveBeenCalled();
	});

	it.each(["rpc", "print", "json"])("never reports in %s mode", async (mode) => {
		const f = await herdrReporterFixture();
		f.ctx.mode = mode as ExtensionContext["mode"];
		await f.start();
		await f.emit("agent_start");
		expect(f.connect).not.toHaveBeenCalled();
	});

	it("defers once to loaded user reporters, including Windows paths", async () => {
		const f = await herdrReporterFixture({
			getLoadedExtensionPaths: () => ["C:\\extensions\\herdr-omo-activity.ts"],
			readHeader: () => "// user reporter",
		});
		await f.start();
		await f.start();
		await f.emit("agent_start");
		expect(f.connect).not.toHaveBeenCalled();
		expect(f.debug).toHaveBeenCalledTimes(1);
	});

	it("coexists with the managed integration and ignores unrelated files", async () => {
		const readHeader = vi.fn(() => "// installed by herdr\n// HERDR_INTEGRATION_ID=pi");
		const f = await herdrReporterFixture({
			getLoadedExtensionPaths: () => ["/x/herdr-agent-state.ts", "/x/unrelated.ts"],
			readHeader,
		});
		await f.start();
		expect(f.requests).toHaveLength(3);
		expect(readHeader).toHaveBeenCalledTimes(1);
	});

	it("does not treat a managed marker after the first 400 bytes as a managed header", async () => {
		const f = await herdrReporterFixture({
			getLoadedExtensionPaths: () => ["/x/herdr-user.mjs"],
			readHeader: () => `${" ".repeat(400)}HERDR_INTEGRATION_ID=pi`,
		});
		await f.start();
		expect(f.connect).not.toHaveBeenCalled();
		expect(f.debug).toHaveBeenCalledTimes(1);
	});

	it("binds lifecycle events to the first TUI session only", async () => {
		const f = await herdrReporterFixture();
		await f.start();
		const child = {
			...f.ctx,
			sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "child" },
		} as ExtensionContext;
		await f.emit("session_start", { reason: "startup" }, child);
		await f.emit("agent_start", {}, child);
		await f.emit("session_shutdown", { reason: "quit" }, child);
		expect(f.requests).toHaveLength(3);
		await f.emit("agent_start");
		expect(f.requests.at(-1)?.params.state).toBe("working");
	});

	it("retains FIFO blocked labels and deduplicates both arrivals and settlements", async () => {
		const f = await herdrReporterFixture();
		await f.start();
		await f.bus("herdr:blocked", { active: true, id: "one", label: "First" });
		await f.bus("herdr:blocked", { active: true, id: "one", label: "Duplicate" });
		await f.bus("herdr:blocked", { active: true, id: "two", label: "Second" });
		expect(f.requests.at(-1)?.params.message).toBe("First");
		await f.bus("herdr:blocked", { active: false, id: "one" });
		expect(f.requests.at(-1)?.params.message).toBe("Second");
		await f.bus("herdr:blocked", { active: false, id: "one" });
		await f.bus("herdr:blocked", { active: false, id: "two" });
		expect(f.requests.filter((r) => r.method === "pane.report_agent").map((r) => r.params.state)).toEqual([
			"idle",
			"blocked",
			"blocked",
			"idle",
		]);
	});

	it("uses live idle state, monitor snapshots and child records with a four-second unref poll", async () => {
		const f = await herdrReporterFixture();
		const tasks = join(f.dir, ".omo", "senpi-task", "tasks");
		mkdirSync(tasks, { recursive: true });
		writeFileSync(
			join(tasks, "child.json"),
			JSON.stringify({ status: "pending", parent_session_id: "root-session" }),
		);
		writeFileSync(join(tasks, "other.json"), JSON.stringify({ status: "running", root_session_id: "other" }));
		writeFileSync(join(tasks, "partial.json"), "{");
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const interval = vi.spyOn(globalThis, "setInterval");
		await f.start();
		expect(interval).toHaveBeenCalledWith(expect.any(Function), 4000);
		expect(interval.mock.results[0]?.value.hasRef()).toBe(false);
		await f.bus("terminal_monitor_state", { activeCount: 2 });
		expect(f.requests.at(-1)?.params).toMatchObject({
			state: "working",
			message: "1 subagent running + 2 monitors live",
		});
		f.setIdle(false);
		await f.emit("agent_start");
		await f.emit("agent_settled");
		writeFileSync(join(tasks, "child.json"), JSON.stringify({ status: "done", parent_session_id: "root-session" }));
		const next = once(f.received, "request", { signal: AbortSignal.timeout(5000) });
		await vi.advanceTimersByTimeAsync(4000);
		await next;
		await f.bus("terminal_monitor_state", { activeCount: 0 });
		expect(f.requests.at(-1)?.params.state).toBe("working");
		f.setIdle(true);
		await f.emit("agent_settled");
		expect(f.requests.at(-1)?.params.state).toBe("idle");
		await f.emit("session_shutdown", { reason: "reload" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports title changes and clearing without duplicating lifecycle state", async () => {
		const f = await herdrReporterFixture();
		await f.start();
		f.setTitle("Renamed");
		await f.emit("session_info_changed", { name: "Renamed" });
		f.setTitle(undefined);
		await f.emit("session_info_changed", { name: undefined });
		expect(f.requests.filter((r) => r.method === "pane.report_metadata").map((r) => r.params.title)).toEqual([
			"Reporter QA",
			"Renamed",
			"",
		]);
		expect(f.requests.filter((r) => r.method === "pane.report_agent")).toHaveLength(1);
	});

	it("ignores malformed bus payloads", async () => {
		const f = await herdrReporterFixture();
		await f.start();
		for (const data of [null, {}, { active: "yes", id: "x" }, { active: true, label: "missing id" }])
			await f.bus("herdr:blocked", data);
		for (const activeCount of [-1, NaN, 1.5, "2"]) await f.bus("terminal_monitor_state", { activeCount });
		expect(f.requests).toHaveLength(3);
	});

	it("never lets a queued report reclaim a released pane", async () => {
		const transport = scriptedTransport(acknowledge);
		const f = await herdrReporterFixture({ connect: transport.connect });
		await f.start();
		const working = f.emit("agent_start");
		const blocked = f.bus("herdr:blocked", { active: true, id: "q", label: "Question" });
		const shutdown = f.emit("session_shutdown", { reason: "quit" });
		await Promise.all([working, blocked, shutdown]);
		await f.emit("agent_start");
		expect(transport.requests.map((r) => r.method)).toEqual([
			"pane.report_metadata",
			"pane.report_agent_session",
			"pane.report_agent",
			"pane.report_agent",
			"pane.report_agent",
			"pane.release_agent",
		]);
	});

	it("logs failed delivery and retries unchanged state on the next signal", async () => {
		let failing = true;
		const transport = scriptedTransport((socket, request) => {
			if (failing) socket.emit("error", new Error("offline"));
			else acknowledge(socket, request);
		});
		const f = await herdrReporterFixture({ connect: transport.connect });
		await f.start();
		expect(f.debug).toHaveBeenCalledTimes(3);
		failing = false;
		await f.emit("agent_settled");
		expect(transport.requests.at(-1)?.params.state).toBe("idle");
		expect(transport.connect).toHaveBeenCalledTimes(7);
	});
});

describe("herdr transport and reducer", () => {
	it("maps Windows pipe endpoints without double-prefixing", () => {
		expect(herdrSocketTarget("/tmp/herdr.sock", "darwin")).toBe("/tmp/herdr.sock");
		expect(herdrSocketTarget("herdr.sock", "win32")).toBe("\\\\.\\pipe\\herdr.sock");
		expect(herdrSocketTarget("\\\\.\\pipe\\herdr.sock", "win32")).toBe("\\\\.\\pipe\\herdr.sock");
		expect(herdrSocketTarget("\\\\?\\pipe\\herdr.sock", "win32")).toBe("\\\\?\\pipe\\herdr.sock");
	});

	it("keeps the reducer immutable and duplicate settlements at zero", () => {
		const empty = initialHerdrState();
		const blocked = reduceHerdrState(empty, { type: "blocked", id: "q", active: true, label: "Question" });
		expect(empty.blocked.size).toBe(0);
		expect(blocked.blocked.size).toBe(1);
		const settled = reduceHerdrState(blocked, { type: "blocked", id: "q", active: false });
		expect(reduceHerdrState(settled, { type: "blocked", id: "q", active: false })).toBe(settled);
		expect(settled.blocked.size).toBe(0);
	});

	it("drains one request at a time, including release, and accepts split NDJSON replies", async () => {
		const t = scriptedTransport();
		const client = new HerdrClient("socket", "pane", { now: () => 500, connect: t.connect });
		const firstWrite = once(t.written, "request", { signal: AbortSignal.timeout(5000) });
		const first = client.send("pane.report_agent", { state: "working" });
		const release = client.send("pane.release_agent", { agent: "pi" });
		await firstWrite;
		expect(t.connect).toHaveBeenCalledTimes(1);
		const releaseWrite = once(t.written, "request", { signal: AbortSignal.timeout(5000) });
		const response = JSON.stringify({ id: t.requests[0]!.id, result: {} });
		t.sockets[0]!.emit("data", Buffer.from(response.slice(0, 4)));
		expect(t.connect).toHaveBeenCalledTimes(1);
		t.sockets[0]!.emit("data", Buffer.from(`${response.slice(4)}\n`));
		await first;
		await releaseWrite;
		acknowledge(t.sockets[1]!, t.requests[1]!);
		await release;
		expect(t.sockets.every((socket) => socket.destroyed)).toBe(true);
		expect(t.requests.map((r) => r.method)).toEqual(["pane.report_agent", "pane.release_agent"]);
	});

	it.each(["error", "malformed", "wrong-id", "rejected", "oversized", "end"])(
		"retries %s once with the same id and sequence",
		async (failure) => {
			const t = scriptedTransport((socket, request, attempt) => {
				if (attempt === 2) return acknowledge(socket, request);
				if (failure === "error") socket.emit("error", new Error("offline"));
				else if (failure === "end") socket.emit("end");
				else
					socket.emit(
						"data",
						Buffer.from(
							failure === "malformed"
								? "{\n"
								: failure === "oversized"
									? "x".repeat(65_537)
									: `${JSON.stringify(failure === "wrong-id" ? { id: "other", result: {} } : { id: request.id, error: { code: "rejected", message: "Rejected" } })}\n`,
						),
					);
			});
			const client = new HerdrClient("socket", "pane", { now: () => 100, connect: t.connect });
			await client.send("pane.report_agent", { state: "idle" });
			expect(t.requests).toHaveLength(2);
			expect(t.requests[0]).toEqual(t.requests[1]);
		},
	);

	it("bounds attempts at 500 then 1500 ms and rejects without stranding the queue", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const t = scriptedTransport();
		const client = new HerdrClient("socket", "pane", { now: () => 100, connect: t.connect });
		const failure = expect(client.send("pane.report_agent", { state: "idle" })).rejects.toThrow("two attempts");
		await vi.advanceTimersByTimeAsync(499);
		expect(t.connect).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(t.connect).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1499);
		expect(t.sockets[1]!.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await failure;
		expect(t.sockets.every((socket) => socket.destroyed)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		const nextWrite = once(t.written, "request", { signal: AbortSignal.timeout(5000) });
		const next = client.send("pane.release_agent", {});
		await nextWrite;
		acknowledge(t.sockets[2]!, t.requests[2]!);
		await next;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps sequence increasing across replacement clients and clock rollback", async () => {
		const t = scriptedTransport(acknowledge);
		await new HerdrClient("socket", "pane", { now: () => 2000, connect: t.connect }).send("pane.report_agent", {});
		await new HerdrClient("socket", "pane", { now: () => 1000, connect: t.connect }).send("pane.report_agent", {});
		expect(t.requests[1]!.params.seq).toBeGreaterThan(t.requests[0]!.params.seq);
	});
});
