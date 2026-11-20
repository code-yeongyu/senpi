import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { RpcMonitorWatch } from "../../../src/core/extensions/builtin/terminal/rpc-monitor-watch.ts";

afterEach(() => vi.useRealTimers());

function fixture(id: string, snapshot: object[]) {
	vi.useFakeTimers();
	const socket = new Socket();
	vi.spyOn(socket, "write").mockImplementation(() => {
		// One read: the answer and the first live frames need not be separate ticks.
		const frames = [
			{ type: "agent_start", sessionId: "other" },
			{ type: "response", id: "monitor-subscribe", success: true, data: { snapshot } },
			{ type: "session_lifecycle", sessionId: "other" },
			{ type: "agent_idle", sessionId: "route" },
		];
		socket.emit("data", Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`));
		return true;
	});
	const lines: string[] = [];
	const watch = new RpcMonitorWatch({
		agentDir: ".",
		target: { kind: "id", id },
		events: "all",
		exclude: [],
		endpoints: async () => ["fixture.sock"],
		connectEndpoint: async () => ({ socket }),
		line: (line) => lines.push(line),
	});
	return { watch, lines, socket };
}

it("does not deliver any records or leave a watch for an unresolved explicit target", async () => {
	const { watch, lines, socket } = fixture("missing", []);
	try {
		const started = watch.start().then(
			() => "armed",
			() => "refused",
		);
		expect.soft(await started).toBe("refused");
		expect(lines).toEqual([]);
		expect(socket.destroyed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		watch.stop();
	}
});

it.each(["route", "durable", "fixture.jsonl"])("only delivers the session selected by %s", async (id) => {
	const { watch, lines } = fixture(id, [
		{ sessionId: "route", durableSessionId: "durable", sessionPath: "fixture.jsonl", status: "idle" },
	]);
	try {
		expect(await watch.start()).toHaveLength(1);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/ agent_idle$/);
	} finally {
		watch.stop();
	}
});

it("follows a durable identity to its new route without following the replaced session", async () => {
	const { watch, lines, socket } = fixture("durable", [
		{ sessionId: "route", durableSessionId: "durable", status: "idle" },
	]);
	try {
		await watch.start();
		lines.length = 0;
		for (const record of [
			{ type: "session_replaced", sessionId: "route", durableSessionId: "different" },
			{ type: "agent_start", sessionId: "route" },
			{ type: "session_status", sessionId: "next", durableSessionId: "durable", status: "idle" },
			{ type: "agent_idle", sessionId: "next" },
		])
			socket.emit("data", Buffer.from(`${JSON.stringify(record)}\n`));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("(next) status");
		expect(lines[1]).toMatch(/ agent_idle$/);
	} finally {
		watch.stop();
	}
});
