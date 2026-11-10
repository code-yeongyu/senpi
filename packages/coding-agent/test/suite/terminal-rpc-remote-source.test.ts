/**
 * oh-my-openagent#12719: an rpc watch on another device's sessions. senpi knows no relay: an extension
 * registers an `RpcRemoteSource`, and a `<device>/<session>` or `<device>/*` target is served by it. A fake
 * source stands in for the extension; every line is the local renderer's, a resync reports what changed
 * once, a turn end is reported once per `turnId`, and the resume position rides the monitor checkpoint.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { MonitorEvent } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { RpcMonitorRenderer } from "../../src/core/extensions/builtin/terminal/rpc-monitor-render.ts";
import type { RpcTarget } from "../../src/core/extensions/builtin/terminal/rpc-monitor-targets.ts";
import {
	type RpcMonitorCheckpoint,
	RpcMonitorWatch,
} from "../../src/core/extensions/builtin/terminal/rpc-monitor-watch.ts";
import type {
	RpcRemoteHandlers,
	RpcRemoteOpenOptions,
	RpcRemoteSource,
	RpcRemoteState,
	RpcRemoteTarget,
} from "../../src/core/extensions/builtin/terminal/rpc-remote-source.ts";

const ROW = { sessionId: "s1", durableSessionId: "abcdef123456", status: "running", attachments: 0 };
const TO_IDLE = {
	type: "session_status",
	sessionId: "s1",
	durableSessionId: "abcdef123456",
	status: "idle",
	seq: 4,
	lastChange: { cause: "turn_end", by: "agent" },
};
const REMOTE: RpcTarget = { kind: "remote", device: "devB", session: "s1" };

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Opened {
	readonly target: RpcRemoteTarget;
	readonly options: RpcRemoteOpenOptions;
	readonly handlers: RpcRemoteHandlers;
	stopped: boolean;
}

function fakeSource(initial: RpcRemoteState): { source: RpcRemoteSource; opened: Opened[] } {
	const opened: Opened[] = [];
	return {
		opened,
		source: {
			async open(target, options, handlers) {
				const entry: Opened = { target, options, handlers, stopped: false };
				opened.push(entry);
				return {
					initial,
					stop: () => {
						entry.stopped = true;
					},
				};
			},
		},
	};
}

function remoteWatch(
	source: RpcRemoteSource,
	lines: string[],
	events: readonly string[] = ["session_status"],
	restoredFrom?: RpcMonitorCheckpoint,
): RpcMonitorWatch {
	const watch = new RpcMonitorWatch({
		agentDir: "/tmp",
		target: REMOTE,
		events,
		exclude: [],
		remoteSource: source,
		...(restoredFrom === undefined ? {} : { restoredFrom }),
		line: (line) => lines.push(line),
	});
	cleanups.push(() => watch.stop());
	return watch;
}

function only(opened: Opened[]): Opened {
	const entry = opened[0];
	if (entry === undefined || opened.length !== 1) throw new Error(`expected one open, saw ${opened.length}`);
	return entry;
}

describe("remote rpc targets (oh-my-openagent#12719)", () => {
	it("renders a remote record exactly as the local renderer renders the same record", async () => {
		const local = new RpcMonitorRenderer();
		const localRows = local.seed("/tmp/h.sock", [ROW]);
		const localLine = local.render("/tmp/h.sock", TO_IDLE);
		const { source, opened } = fakeSource({ rows: [ROW] });
		const lines: string[] = [];
		const watch = remoteWatch(source, lines);

		const rows = await watch.start();
		only(opened).handlers.record(TO_IDLE);

		expect(only(opened).target).toEqual({ device: "devB", session: "s1" });
		expect(rows).toEqual(localRows);
		expect(lines).toEqual([localLine]);
		expect(localLine).toBe("rpc abcdef12 (s1) status running -> idle (turn_end, by agent) seq=4");
	});

	it("says a lost device once, and a resync after the gap reports each change exactly once", async () => {
		const { source, opened } = fakeSource({ rows: [ROW] });
		const lines: string[] = [];
		const watch = remoteWatch(source, lines);
		await watch.start();
		const { handlers } = only(opened);

		handlers.lost("connection closed");
		handlers.lost("connection closed");
		handlers.resynced({ rows: [{ ...ROW, status: "idle" }] });
		handlers.resynced({ rows: [{ ...ROW, status: "idle" }] });

		expect(lines).toEqual([
			"rpc device devB unreachable (connection closed); re-watching",
			"rpc s1 status running -> idle (changed while detached)",
		]);
		expect(watch.checkpoint().statuses).toEqual({ "devB#s1": "idle" });
	});

	it("reports a turn end once per turnId, across a resnapshot", async () => {
		const { source, opened } = fakeSource({ rows: [ROW] });
		const lines: string[] = [];
		const watch = remoteWatch(source, lines, ["session_status", "agent_settled"]);
		await watch.start();
		const { handlers } = only(opened);
		const settled = { type: "agent_settled", sessionId: "s1", durableSessionId: "abcdef123456", turnId: "7" };

		handlers.record(settled);
		handlers.resynced({ rows: [ROW], settledTurns: [{ sessionId: "s1", turnId: "7" }] });
		handlers.record(settled);
		handlers.resynced({ rows: [ROW], settledTurns: [{ sessionId: "s1", turnId: "8" }] });

		expect(lines).toEqual(["rpc abcdef12 (s1) agent_settled", "rpc s1 turn 8 settled while detached"]);
	});

	it("saves the resume position, and a restore resumes from it and reports the turn that settled meanwhile", async () => {
		const first = fakeSource({ rows: [ROW], cursor: "c-1" });
		const before = remoteWatch(first.source, [], ["session_status", "agent_settled"]);
		await before.start();
		const { handlers } = only(first.opened);
		handlers.record({ type: "agent_settled", sessionId: "s1", turnId: "7" });
		handlers.cursor("c-9");
		const saved = before.checkpoint();
		before.stop();

		const second = fakeSource({
			rows: [{ ...ROW, status: "idle" }],
			settledTurns: [
				{ sessionId: "s1", turnId: "7" },
				{ sessionId: "s1", turnId: "8" },
			],
			cursor: "c-12",
		});
		const after = remoteWatch(second.source, [], ["session_status", "agent_settled"], saved);
		await after.start();

		expect(saved.remote).toEqual({ cursor: "c-9", settled: { "devB#s1": ["7"] } });
		expect(only(first.opened).stopped).toBe(true);
		expect(only(second.opened).options.resumeFrom).toBe("c-9");
		expect(after.diffSince(saved)).toEqual([
			"rpc s1 status running -> idle (changed while detached)",
			"rpc s1 turn 8 settled while detached",
		]);
		expect(after.checkpoint().remote).toEqual({ cursor: "c-12", settled: { "devB#s1": ["7", "8"] } });
	});

	it("an access that ended settles the monitor, says why, and stops the source", async () => {
		const { source, opened } = fakeSource({ rows: [ROW] });
		const events: MonitorEvent[] = [];
		const registry = new MonitorRegistry((event) => events.push(event));
		cleanups.push(() => registry.dispose());
		await registry.registerRpc({
			description: "remote",
			target: REMOTE,
			targetText: "devB/s1",
			events: ["session_status"],
			exclude: [],
			persistent: false,
			agentDir: "/tmp",
			remoteSource: source,
		});

		only(opened).handlers.ended("peer_revoked");

		expect(events.filter((event) => event.type === "line").map((event) => event.line)).toEqual([
			"rpc devB/s1 access ended (peer_revoked)",
		]);
		expect(events.find((event) => event.type === "summary")).toMatchObject({
			summary: "access ended (peer_revoked)",
		});
		expect(only(opened).stopped).toBe(true);
	});

	it("an open the source refuses fails the arm and leaves no watch behind", async () => {
		const registry = new MonitorRegistry(() => {});
		cleanups.push(() => registry.dispose());
		const refusing: RpcRemoteSource = {
			open: async () => {
				throw new Error("plan_required");
			},
		};

		await expect(
			registry.registerRpc({
				description: "remote",
				target: REMOTE,
				targetText: "devB/s1",
				events: ["session_status"],
				exclude: [],
				persistent: false,
				agentDir: "/tmp",
				remoteSource: refusing,
			}),
		).rejects.toThrow("plan_required");
		expect(registry.stopAllRpc()).toBe(0);
	});
});
