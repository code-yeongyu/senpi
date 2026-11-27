import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSessionLiveness } from "../../src/core/extensions/builtin/session-liveness/connect.ts";
import { createSessionLivenessWatcher } from "../../src/core/extensions/builtin/session-liveness/watcher.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

// senpi#1146 review: the child-record poll and scans run only while a consumer is subscribed.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function watcherSession() {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Set<(data: unknown) => unknown>>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (name: string, handler: (data: unknown) => unknown) => {
				const set = bus.get(name) ?? new Set();
				set.add(handler);
				bus.set(name, set);
				return () => set.delete(handler);
			},
			emit: (name: string, data: unknown) => {
				for (const handler of bus.get(name) ?? []) handler(data);
			},
		},
	} as unknown as ExtensionAPI;
	const polls = { started: 0, stopped: 0 };
	// The task directory is a file, so every read of it fails and reports through `debug`.
	const debug = vi.fn<(message: string) => void>();
	createSessionLivenessWatcher(pi, {
		debug,
		schedulePoll: () => {
			polls.started++;
			return () => {
				polls.stopped++;
			};
		},
	});
	const cwd = mkdtempSync(join(tmpdir(), "liveness-poll-"));
	roots.push(cwd);
	mkdirSync(join(cwd, ".omo", "senpi-task"), { recursive: true });
	writeFileSync(join(cwd, ".omo", "senpi-task", "tasks"), "not a directory");
	const ctx = { cwd, isIdle: () => true, sessionManager: { getSessionId: () => "s1" } } as unknown as ExtensionContext;
	const emit = async (type: string) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, reason: "startup" }, ctx);
	};
	const consumer = () => connectSessionLiveness(pi.events)?.subscribe(() => {});
	return { emit, consumer, polls, scans: () => debug.mock.calls.length };
}

describe("session liveness child-record poll (senpi#1146)", () => {
	it("neither polls nor reads the child records while nothing consumes the liveness", async () => {
		const session = await watcherSession();
		await session.emit("session_start");
		await session.emit("agent_start");
		await session.emit("agent_settled");

		expect(session.polls).toEqual({ started: 0, stopped: 0 });
		expect(session.scans()).toBe(0);
	});

	it("starts one poll with the first consumer, refreshes at each subscribe and stops after the last one leaves", async () => {
		const session = await watcherSession();
		await session.emit("session_start");

		const first = session.consumer();
		expect(session.polls).toEqual({ started: 1, stopped: 0 });
		expect(session.scans()).toBe(1);
		const second = session.consumer();
		expect(session.polls).toEqual({ started: 1, stopped: 0 });
		expect(session.scans()).toBe(2);

		first?.();
		expect(session.polls).toEqual({ started: 1, stopped: 0 });
		second?.();
		expect(session.polls).toEqual({ started: 1, stopped: 1 });
	});

	it("stops the poll at session shutdown while a consumer is still subscribed", async () => {
		const session = await watcherSession();
		await session.emit("session_start");
		session.consumer();

		await session.emit("session_shutdown");
		expect(session.polls).toEqual({ started: 1, stopped: 1 });
	});
});
