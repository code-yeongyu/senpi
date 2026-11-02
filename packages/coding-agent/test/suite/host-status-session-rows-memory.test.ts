import { describe, expect, it } from "vitest";
import { parseSessionRows } from "../../src/modes/rpc/host-status-rows.ts";

// senpi#1960: the status row a client parses carries the per-session memory the host published on
// the listing, so `senpi host status --all --include-workers --json` shows the split without a probe.

describe("session row memory parsing (#1960)", () => {
	it("carries the published memory block onto the parsed row", () => {
		const rows = parseSessionRows({
			sessions: [
				{
					sessionId: "sess-1",
					kind: "worker",
					sessionPath: "/tmp/a.jsonl",
					cwd: "/tmp",
					attachments: 1,
					memory: { main_heap_bytes: 50331648, kernel_heap_bytes: 209715200, kernel_count: 1 },
				},
			],
		});
		expect(rows).toEqual([
			{
				id: "sess-1",
				kind: "worker",
				session_path: "/tmp/a.jsonl",
				cwd: "/tmp",
				name: null,
				attachments: 1,
				context: null,
				memory: { main_heap_mb: 48, kernel_heap_mb: 200, kernel_count: 1 },
			},
		]);
	});

	it("reports a session without a kernel as zeros, and an unpublished block as zeros too", () => {
		const rows = parseSessionRows({
			sessions: [
				{ sessionId: "sess-1", kind: "interactive", cwd: "/tmp", attachments: 0 },
				{
					sessionId: "sess-2",
					kind: "worker",
					cwd: "/tmp",
					attachments: 0,
					memory: { main_heap_bytes: 33554432, kernel_heap_bytes: 0, kernel_count: 0 },
				},
			],
		});
		expect(rows[0]?.memory).toEqual({ main_heap_mb: 0, kernel_heap_mb: 0, kernel_count: 0 });
		expect(rows[1]?.memory).toEqual({ main_heap_mb: 32, kernel_heap_mb: 0, kernel_count: 0 });
	});
});
