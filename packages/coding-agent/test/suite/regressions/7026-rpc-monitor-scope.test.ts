import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { RpcMonitorWatch } from "../../../src/core/extensions/builtin/terminal/rpc-monitor-watch.ts";
import { connectAuthenticatedRpcSocket } from "../../../src/modes/rpc/rpc-auth-client.ts";

vi.mock("../../../src/modes/rpc/rpc-auth-client.ts", () => ({ connectAuthenticatedRpcSocket: vi.fn() }));

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
	vi.mocked(connectAuthenticatedRpcSocket).mockResolvedValue({ socket, protocol: {} });
	const lines: string[] = [];
	const watch = new RpcMonitorWatch({
		agentDir: ".",
		target: { kind: "id", id },
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
