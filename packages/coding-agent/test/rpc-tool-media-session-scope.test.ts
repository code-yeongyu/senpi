import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";

const FIRST = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const SECOND = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let sessionDir: string;
beforeEach(() => {
	sessionDir = mkdtempSync(join(tmpdir(), "senpi-media-scope-"));
});
afterEach(() => {
	rmSync(sessionDir, { recursive: true, force: true });
});

const state = (id: string) => ({ sessionId: id, sessionFile: join(sessionDir, `${id}.jsonl`) });

/**
 * A worker-runtime session as the host sees it: no in-process runtime, only the worker's snapshot,
 * which the worker refreshes whenever the session is replaced (new_session, switch_session, fork).
 */
async function openWorkerSession() {
	const entry = {
		state: "open",
		kind: "interactive",
		context: {},
		durableSessionId: FIRST,
		sessionPath: state(FIRST).sessionFile,
		worker: { snapshot: { state: state(FIRST) }, bindingReady: false, exited: new Promise(() => {}) },
	};
	const registry = {
		openSession: async () => ({ sessionId: "rpc-1" }),
		getForCommand: () => entry,
		list: () => [],
		beginClose: () => entry,
		closeMarked: async () => {},
		peek: () => undefined,
	} as never;
	const lines: string[] = [];
	const writer = new SessionEventWriter(
		() => {},
		(flush) => flush(),
	);
	writer.registerConnection("client", {
		writeRaw: (chunk) => lines.push(chunk),
		waitForBackpressure: async () => {},
	});
	const createBinding = vi.fn(async () => ({ handle: async () => {}, dispose: async () => {} }));
	const router = Reflect.construct(SessionCommandRouter, [
		registry,
		writer,
		{ cwd: "/tmp" },
		createBinding,
		{},
	]) as SessionCommandRouter;
	await writer.withConnection("client", () =>
		router.handle({ id: "caps", type: "set_client_info", width: 80, capabilities: ["media_placeholders"] }),
	);
	await writer.withConnection("client", () => router.handle({ id: "open", type: "open_session", cwd: "/tmp" }));
	lines.length = 0;
	const shoot = async (toolCallId: string): Promise<string | undefined> => {
		lines.length = 0;
		writer.enqueue("rpc-1", {
			type: "tool_execution_end",
			toolCallId,
			result: { content: [{ type: "image", data: PNG, mimeType: "image/png" }] },
		});
		await writer.flush();
		const record = JSON.parse(lines.join("").split("\n").filter(Boolean).at(-1) ?? "{}") as {
			result?: { content?: Array<{ path?: string }> };
		};
		return record.result?.content?.[0]?.path;
	};
	return { entry, shoot };
}

test("files an image taken after a session switch under the NEW session, not the one the worker opened with", async () => {
	const { entry, shoot } = await openWorkerSession();
	const before = await shoot("call_before");
	expect(before).toContain(join(sessionDir, "media", FIRST));

	entry.worker.snapshot = { state: state(SECOND) };
	const after = await shoot("call_after");

	expect(after).toContain(join(sessionDir, "media", SECOND));
	expect(after).not.toContain(FIRST);
	expect(after !== undefined && existsSync(after)).toBe(true);
});

test("stores no image rather than file it under the wrong session when the worker has no live state yet", async () => {
	const { entry, shoot } = await openWorkerSession();
	(entry.worker as { snapshot?: unknown }).snapshot = undefined;

	expect(await shoot("call_early")).toBeUndefined();
	expect(existsSync(join(sessionDir, "media"))).toBe(false);
});
