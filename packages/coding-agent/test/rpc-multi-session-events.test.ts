import { describe, expect, it } from "vitest";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { SessionExtensionUiRequests } from "../src/modes/rpc/session-extension-ui-requests.ts";

function records(chunks: readonly string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("multi-session RPC event writer", () => {
	it("tags every record, preserves per-session FIFO, and round-robins complete records", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", { type: "message_update", sequence: 1 });
		writer.enqueue("a", { type: "tool_execution_update", payload: "x".repeat(128 * 1024) });
		writer.enqueue("b", { type: "message_update", sequence: 1 });
		writer.enqueue("a", { type: "agent_settled", sequence: 2 });
		writer.enqueue("b", { type: "agent_settled", sequence: 2 });
		scheduled[0]!();

		expect(records(chunks)).toEqual([
			{ type: "message_update", sequence: 1, sessionId: "a" },
			{ type: "message_update", sequence: 1, sessionId: "b" },
			{ type: "tool_execution_update", payload: "x".repeat(128 * 1024), sessionId: "a" },
			{ type: "agent_settled", sequence: 2, sessionId: "b" },
			{ type: "agent_settled", sequence: 2, sessionId: "a" },
		]);
		// Each complete record is its own raw write: sessions are never coalesced.
		expect(chunks).toHaveLength(5);
	});

	it("routes extension UI responses only to that session's pending map and rejects pending work on close", () => {
		const a = new SessionExtensionUiRequests();
		const b = new SessionExtensionUiRequests();
		let resolvedA = false;
		let resolvedB = false;
		let rejectedA = false;
		a.set("request", { resolve: () => (resolvedA = true), reject: () => (rejectedA = true) });
		b.set("request", { resolve: () => (resolvedB = true), reject: () => {} });

		expect(a.resolve({ type: "extension_ui_response", id: "request", value: "A" })).toBe(true);
		expect(resolvedA).toBe(true);
		expect(resolvedB).toBe(false);
		a.set("closing", { resolve: () => {}, reject: () => (rejectedA = true) });
		a.close();
		expect(rejectedA).toBe(true);
		expect(a.resolve({ type: "extension_ui_response", id: "closing", value: "late" })).toBe(false);
		expect(b.resolve({ type: "extension_ui_response", id: "request", value: "B" })).toBe(true);
		expect(resolvedB).toBe(true);
	});

	it("does not emit after a session is sealed, while allowing its terminal close response", () => {
		const chunks: string[] = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => flush(),
		);

		writer.enqueue("a", { type: "message_update" });
		writer.closeSession("a", { id: "close-a", type: "response", command: "close_session", success: true });
		writer.enqueue("a", { type: "agent_settled" });
		writer.enqueue("b", { type: "agent_settled" });
		writer.flush();

		expect(records(chunks)).toEqual([
			{ type: "message_update", sessionId: "a" },
			{ id: "close-a", type: "response", command: "close_session", success: true, sessionId: "a" },
			{ type: "agent_settled", sessionId: "b" },
		]);
	});
});
