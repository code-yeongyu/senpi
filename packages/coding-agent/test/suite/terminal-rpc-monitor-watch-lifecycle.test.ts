/**
 * senpi#3381 review: an rpc watch's endpoint lifecycle. A watch stopped while an observer is still
 * connecting closes that observer; an endpoint whose connection ends is reported once and forgotten; and a
 * restore only says a session closed when its host answered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const opened: Array<{
	socket: string;
	closed: boolean;
	finish: () => void;
	handlers: { closed(reason: string): void };
}> = [];
let release: (() => void) | undefined;

vi.mock("../../src/core/extensions/builtin/terminal/rpc-monitor-observer.ts", () => ({
	openRpcObserver: async (socket: string, _subscription: unknown, handlers: { closed(reason: string): void }) => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		const entry = {
			socket,
			closed: false,
			handlers,
			finish: () => {},
		};
		opened.push(entry);
		return {
			subscribed: Promise.resolve({
				type: "response",
				success: true,
				data: {
					hostInstanceId: "i-1",
					hostGeneration: "1",
					snapshot: [{ sessionId: "s1", status: "busy", attachments: 1 }],
				},
			}),
			close: () => {
				entry.closed = true;
			},
		};
	},
}));

const { RpcMonitorWatch } = await import("../../src/core/extensions/builtin/terminal/rpc-monitor-watch.ts");

afterEach(() => {
	opened.length = 0;
	release = undefined;
});

function watch(lines: string[], target: { kind: "all" } | { kind: "children"; parent: string } = { kind: "all" }) {
	return new RpcMonitorWatch({
		agentDir: "/tmp",
		target: target as never,
		events: ["session_status"],
		exclude: [],
		endpoints: async () => ["/tmp/h.sock"],
		line: (line) => lines.push(line),
	});
}

async function settled(): Promise<void> {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}

describe("rpc watch endpoint lifecycle (senpi#3381 review)", () => {
	it("closes an observer that finished connecting after the watch was stopped", async () => {
		const lines: string[] = [];
		const subject = watch(lines);
		const started = subject.start();
		await vi.waitFor(() => expect(release).toBeDefined());
		subject.stop();
		release?.();
		await started;

		expect(opened).toHaveLength(1);
		expect(opened[0]?.closed).toBe(true);
	});

	it("reports an endpoint whose connection ended, once, and forgets its sessions", async () => {
		const lines: string[] = [];
		const subject = watch(lines);
		const started = subject.start();
		await vi.waitFor(() => expect(release).toBeDefined());
		release?.();
		expect(await started).toHaveLength(1);

		opened[0]?.handlers.closed("host gone");
		opened[0]?.handlers.closed("host gone");
		await settled();

		expect(lines.filter((line) => line.startsWith("rpc host /tmp/h.sock gone"))).toEqual([
			"rpc host /tmp/h.sock gone (1 session no longer watched)",
		]);
		expect(subject.checkpoint()).toEqual({ hosts: {}, statuses: {} });
		subject.stop();
	});

	it("says unreachable, not closed, for a saved session whose host did not answer", async () => {
		const subject = watch([]);
		expect(
			subject.diffSince({
				hosts: { "/tmp/other.sock": { instanceId: "i", generation: "1" } },
				statuses: { "/tmp/other.sock#abcdef123": "busy" },
			}),
		).toEqual(["rpc abcdef12 unreachable (its host did not answer)"]);
	});
});
