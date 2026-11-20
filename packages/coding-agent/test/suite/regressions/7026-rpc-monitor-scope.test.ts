import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcTarget } from "../../../src/core/extensions/builtin/terminal/rpc-monitor-targets.ts";
import {
	type RpcMonitorCheckpoint,
	RpcMonitorWatch,
} from "../../../src/core/extensions/builtin/terminal/rpc-monitor-watch.ts";
import * as hostTransport from "../../../src/modes/rpc/rpc-auth-client.ts";
import * as socketTransport from "../../../src/modes/rpc/tui-socket.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(target: string | RpcTarget, snapshot: object[], restoredFrom?: RpcMonitorCheckpoint) {
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
	vi.spyOn(socketTransport, "socketNeedsHandshake").mockReturnValue(false);
	vi.spyOn(hostTransport, "connectAuthenticatedRpcSocket").mockResolvedValue({ socket, protocol: {} });
	const lines: string[] = [];
	const watch = new RpcMonitorWatch({
		agentDir: ".",
		target: typeof target === "string" ? { kind: "id", id: target } : target,
		...(restoredFrom ? { restoredFrom } : {}),
		events: "all",
		exclude: [],
		endpoints: async () => ["fixture.sock"],
		line: (line) => lines.push(line),
	});
	return { watch, lines, socket };
}

it("does not deliver any records or leave a watch for an unresolved explicit target", async () => {
	const { watch, lines, socket } = fixture("missing", []);
	try {
		await expect(watch.start()).rejects.toThrow("no matching local session");
		expect(lines).toEqual([]);
		expect(socket.destroyed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		watch.stop();
	}
});

it.each<RpcTarget>([
	{ kind: "id", id: "old" },
	{ kind: "task", taskId: "st_old" },
])("restores a $kind watch and distinguishes an empty host from one that did not answer", async (target) => {
	const saved = { hosts: {}, statuses: { "fixture.sock#old": "idle", "offline.sock#other": "idle" } };
	const { watch, lines } = fixture(target, [], saved);
	try {
		expect(await watch.start()).toEqual([]);
		expect(lines).toEqual([]);
		expect(watch.diffSince(saved)).toEqual([
			"rpc old closed (gone while detached)",
			"rpc other unreachable (its host did not answer)",
		]);
		expect(vi.getTimerCount()).toBe(1);
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
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("session_replaced -> different");
		expect(lines[1]).toContain("(next) status");
		expect(lines[2]).toMatch(/ agent_idle$/);
	} finally {
		watch.stop();
	}
});
