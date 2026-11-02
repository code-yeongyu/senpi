import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { z } from "zod";

/**
 * Assertion and metric helpers shared by the in-process host suites: they read a reply,
 * a transcript or the host's own thread count, and none of them constructs a host - the
 * rig that does lives in `rpc-inprocess-host-support.ts`.
 */
const openedSchema = z.object({
	type: z.literal("response"),
	command: z.literal("open_session"),
	success: z.literal(true),
	data: z.object({
		sessionId: z.string(),
		attached: z.boolean().optional(),
		state: z.object({ sessionId: z.string(), sessionFile: z.string() }),
	}),
});
const listedSchema = z.object({
	success: z.literal(true),
	data: z.object({ sessions: z.array(z.object({ sessionId: z.string() })) }),
});
const outcomeSchema = z.object({ success: z.boolean(), error: z.string().optional() });

export function listedSessions(record: unknown) {
	return listedSchema.parse(record).data.sessions;
}

/** Names the refusal in the failure message: a capped host answers `open_failed: too_many_sessions`. */
export function opened(record: unknown, index: number) {
	const outcome = outcomeSchema.parse(record);
	if (!outcome.success) throw new Error(`open_session ${index} failed: ${outcome.error}`);
	return openedSchema.parse(record).data;
}

/**
 * Threads a session may add without being an isolate. A session costs watcher
 * threads in BOTH runtimes (measured on macOS: 2.0/session in-process); a worker
 * session additionally carries its own isolate (measured 3.0/session). The bound
 * is the ceiling between those two, so an isolate creeping back onto the daemon
 * path shows up here; the hard proof stays the 20-worker cap.
 */
export const MAX_THREADS_PER_SESSION = 3;

/** Persisted transcript entries of one session file: one JSONL line per appended entry. */
export function transcriptLines(sessionFile: string): number {
	// A session that has persisted nothing yet has no file on disk: zero entries.
	const content = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trimEnd() : "";
	return content === "" ? 0 : content.split("\n").length;
}

/** Live thread count of one process: macOS exposes threads through `ps -M`, Linux through /proc. */
export function threadCount(pid: number): number {
	if (process.platform === "linux") {
		return Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^Threads:\s+(\d+)$/m)?.[1]);
	}
	// `ps -M <pid> | wc -l` minus the header row.
	return (
		execFileSync("ps", ["-M", String(pid)], { encoding: "utf8" })
			.trim()
			.split("\n").length - 1
	);
}

/** The one persisted artifact of a settled turn in these tests: the assistant's message. */
export function assistantMessage(text: string): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
