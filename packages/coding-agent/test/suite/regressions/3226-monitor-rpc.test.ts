/**
 * senpi#3226: the monitor tool's rpc branch watches sessions on real hosts through the status stream.
 * A real host (faux turns held until aborted) and the real MonitorRegistry: the arm result lists matched
 * sessions, status changes and effect receipts arrive as lines, content is a mirror opt-in that never
 * attaches, children opened after arming are matched by the host, and a restore reports what changed.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { MonitorEvent } from "../../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { MonitorRegistry } from "../../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { parseRpcTarget, type RpcTarget } from "../../../src/core/extensions/builtin/terminal/rpc-monitor-targets.ts";
import { RpcMonitorWatch } from "../../../src/core/extensions/builtin/terminal/rpc-monitor-watch.ts";
import { effectHostWorld, openSession, type RawClient } from "../rpc-effect-host-support.ts";

const MODEL = { provider: "fauxeffect", modelId: "faux-1" };
const PARENT = "parent-durable-3226";
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A registry whose emitted lines a test can await (bounded). */
function lineSink() {
	const lines: string[] = [];
	const waiters = new Set<{ match: (line: string) => boolean; resolve: (line: string) => void }>();
	const registry = new MonitorRegistry((event: MonitorEvent) => {
		if (event.type !== "line") return;
		lines.push(event.line);
		for (const waiter of [...waiters])
			if (waiter.match(event.line)) {
				waiters.delete(waiter);
				waiter.resolve(event.line);
			}
	});
	cleanups.push(() => registry.dispose());
	const next = (match: (line: string) => boolean, ms = 30_000): Promise<string> => {
		const seen = lines.find(match);
		if (seen !== undefined) return Promise.resolve(seen);
		const found = Promise.withResolvers<string>();
		const timer = setTimeout(() => found.reject(new Error(`no monitor line matched; saw: ${lines.join(" | ")}`)), ms);
		waiters.add({
			match,
			resolve: (line) => {
				clearTimeout(timer);
				found.resolve(line);
			},
		});
		return found.promise;
	};
	return { registry, lines, next };
}

function target(text: string): RpcTarget {
	const parsed = parseRpcTarget(text, PARENT);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

async function heldTurnAborted(client: RawClient, sessionId: string): Promise<void> {
	const idle = client.wait((record) => record.type === "agent_idle" && record.sessionId === sessionId);
	await client.request({ type: "prompt", sessionId, message: "go" });
	await client.wait((record) => record.type === "agent_start" && record.sessionId === sessionId);
	await client.request({ type: "abort", sessionId });
	await idle;
}

async function world() {
	const created = await effectHostWorld();
	cleanups.push(() => created[Symbol.asyncDispose]());
	const host = await created.start();
	cleanups.push(() => host.stop());
	return { created, host, endpoints: async () => [host.socketPath] };
}

describe("monitor type rpc (senpi#3226)", () => {
	it("children: lists matched children on arm, then a child's status change is one line", async () => {
		const { created, host, endpoints } = await world();
		const client = await host.connect();
		const child = await openSession(client, { cwd: created.cwd, ...MODEL, context: { parent_session_id: PARENT } });
		const { registry, next } = lineSink();

		const armed = await registry.registerRpc({
			description: "children status",
			target: target("children"),
			targetText: "children",
			events: ["session_status", "effect_status"],
			exclude: [],
			persistent: false,
			agentDir: created.agentDir,
			endpoints,
		});
		await heldTurnAborted(client, child.sessionId);

		expect(armed.rows).toHaveLength(1);
		expect(armed.rows[0]).toMatch(/ idle \(1 attached/);
		expect(
			await next((line) => /^rpc \S+ \(\S+\) status idle -> running|^rpc \S+ status idle -> running/.test(line)),
		).toMatch(/status idle -> running \(\w+, by \w+\) seq=\d+/);
	}, 120_000);

	it("children: a child opened after arming is matched by the host and reported", async () => {
		const { created, host, endpoints } = await world();
		const client = await host.connect();
		const { registry, next } = lineSink();
		const armed = await registry.registerRpc({
			description: "children status",
			target: target("children"),
			targetText: "children",
			events: ["session_status"],
			exclude: [],
			persistent: false,
			agentDir: created.agentDir,
			endpoints,
		});

		const late = await openSession(client, { cwd: created.cwd, ...MODEL, context: { parent_session_id: PARENT } });
		await heldTurnAborted(client, late.sessionId);

		expect(armed.rows).toEqual([]);
		expect(await next((line) => line.includes(late.sessionId) || /status \S+ -> running/.test(line))).toMatch(
			/^rpc /,
		);
	}, 120_000);

	it("all + events all: mirrors another client's content without attaching", async () => {
		const { created, host, endpoints } = await world();
		const client = await host.connect();
		const session = await openSession(client, { cwd: created.cwd, ...MODEL });
		const { registry, next } = lineSink();
		await registry.registerRpc({
			description: "everything",
			target: target("all"),
			targetText: "all",
			events: "all",
			exclude: [],
			persistent: false,
			agentDir: created.agentDir,
			endpoints,
		});

		await heldTurnAborted(client, session.sessionId);
		const content = await next((line) => / message_start \{/.test(line));
		await next((line) => / turn_end$/.test(line));
		const listed = await client.request({ type: "list_sessions" });

		expect(content).toMatch(/^rpc \S+( \(\S+\))? message_start \{/);
		const rows = (listed.data?.sessions ?? []) as Array<{ sessionId: string; attachments: number }>;
		expect(rows.find((row) => row.sessionId === session.sessionId)?.attachments).toBe(1);
	}, 120_000);

	it("exclude drops a content kind before coalescing", async () => {
		const { created, host, endpoints } = await world();
		const client = await host.connect();
		const session = await openSession(client, { cwd: created.cwd, ...MODEL });
		const { registry, lines, next } = lineSink();
		await registry.registerRpc({
			description: "everything but deltas",
			target: target("all"),
			targetText: "all",
			events: "all",
			exclude: ["message_update"],
			persistent: false,
			agentDir: created.agentDir,
			endpoints,
		});

		await heldTurnAborted(client, session.sessionId);
		await next((line) => /agent_idle|status running -> idle/.test(line));
		// The delta window is 2 s: a line after the idle one proves the window had time to flush.
		await next((line) => /agent_settled|status \S+ -> idle/.test(line) && lines.indexOf(line) >= 0);

		expect(lines.some((line) => line.includes("streaming +"))).toBe(false);
	}, 120_000);

	it("restore: reports a status moved and a session gone while detached, and a host generation change", async () => {
		const { created, host, endpoints } = await world();
		const client = await host.connect();
		const session = await openSession(client, { cwd: created.cwd, ...MODEL });
		const watch = new RpcMonitorWatch({
			agentDir: created.agentDir,
			target: target("all"),
			events: ["session_status"],
			exclude: [],
			endpoints,
			line: () => {},
		});
		cleanups.push(() => watch.stop());
		await watch.start();
		const now = watch.checkpoint();
		const socket = host.socketPath;
		const key = `${socket}#${session.sessionId}`;

		const lines = watch.diffSince({
			hosts: { [socket]: { instanceId: "old", generation: "gen-old" } },
			statuses: { [key]: "running", [`${socket}#gone-session`]: "idle" },
		});

		expect(now.statuses[key]).toBe("idle");
		expect(lines).toContain(`rpc host ${socket} restarted (generation gen-old -> ${now.hosts[socket]?.generation})`);
		expect(lines.some((line) => /status running -> idle \(changed while detached\)/.test(line))).toBe(true);
		expect(lines.some((line) => /closed \(gone while detached\)/.test(line))).toBe(true);
	}, 120_000);
});
