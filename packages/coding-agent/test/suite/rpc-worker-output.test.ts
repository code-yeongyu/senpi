import { expect, it } from "vitest";
import { MAX_SHARED_STDIO_QUEUE_RECORDS, SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

it("bounds a stalled stdio queue and preserves an explicit session terminal failure", async () => {
	const lines: string[] = [];
	// Hold the actual writer's scheduler, rather than relying on a timing window.
	const writer = new SessionEventWriter(
		(line) => lines.push(line),
		(_flush) => {},
	);
	const pending: Promise<void>[] = [];
	for (let i = 0; i < MAX_SHARED_STDIO_QUEUE_RECORDS; i++)
		pending.push(writer.enqueueControl({ type: "response", command: "list_sessions", id: String(i), success: true }));
	expect(writer.enqueue("worker-a", { type: "message_end" })).toBe(false);
	await expect(writer.enqueueControl({ type: "response", id: "overflow" })).rejects.toThrow(
		"rpc_control_output_overflow",
	);
	await expect(writer.enqueueControl({ type: "response", id: "overflow-again" })).rejects.toThrow(
		"rpc_control_output_overflow",
	);
	expect(writer.bufferedRecordCount).toBe(MAX_SHARED_STDIO_QUEUE_RECORDS + 3);
	await writer.flush();
	await Promise.all(pending);
	const terminal = lines.filter((line) => line.includes('"sessionId":"worker-a"'));
	expect(terminal).toHaveLength(2);
	expect(JSON.parse(terminal[0]).type).toBe("session_closed");
	expect(JSON.parse(terminal[1]).error).toBe("session_output_overflow, resync required");
	expect(lines.filter((line) => JSON.parse(line).type === "overflow")).toHaveLength(1);
	expect(writer.bufferedRecordCount).toBe(0);
}, 30_000);
