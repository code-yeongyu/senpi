import type * as FsModule from "fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeSessionRecords } from "../../../src/modes/rpc/session-record-stream.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * senpi#4295: a full disk during a turn is reported as a typed, actionable error on every surface (the prompt
 * rejection, the `transcript_write_failed` event and the RPC record stream), never as the raw `ENOSPC` text.
 */

const fault = vi.hoisted(() => ({ code: undefined as "ENOSPC" | "EDQUOT" | undefined }));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			const [path] = args;
			const code = fault.code;
			if (code === undefined || typeof path !== "string" || !path.endsWith(".jsonl")) {
				return actual.appendFileSync(...args);
			}
			const text = code === "ENOSPC" ? "no space left on device" : "disk quota exceeded";
			throw Object.assign(new Error(`${code}: ${text}, write`), { code });
		},
	};
});

const harnesses: Harness[] = [];
afterEach(() => {
	fault.code = undefined;
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function savedHarness(): Promise<{ harness: Harness; file: string; records: object[] }> {
	const harness = await createHarness({ persistSession: true, extensionFactories: [] });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("refused reply")]);
	await harness.session.prompt("first");
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("test setup: persisted session has no file");
	const records: object[] = [];
	subscribeSessionRecords(harness.session, (record) => records.push(record));
	return { harness, file, records };
}

describe("senpi#4295 disk full during a turn", () => {
	it.each(["ENOSPC", "EDQUOT"] as const)(
		"reports %s as a typed disk_full error on the prompt, the event and the RPC stream",
		async (code) => {
			// Given a saved session
			const { harness, file, records } = await savedHarness();

			// When the disk fills up during the next turn
			fault.code = code;
			const refused = await harness.session.prompt("second").then(
				() => undefined,
				(error: unknown) => error,
			);

			// Then the prompt rejects with the typed error, naming the file, the space it needed and what to do
			expect(refused).toMatchObject({ code, errorCause: "disk_full", path: file });
			const typed = refused as { message: string; neededBytes: number };
			expect(typed.neededBytes).toBeGreaterThan(0);
			expect(typed.message).toMatch(/^Disk full: /);
			expect(typed.message).toContain("Free disk space, then continue this session");
			expect(typed.message).not.toMatch(/^[A-Z]+: /);
			// And the event and the RPC record carry the same cause instead of the raw text
			const events = harness.eventsOfType("transcript_write_failed");
			expect(events.map((event) => event.errorCause)).toEqual(["disk_full", "disk_full"]);
			expect(events[0]?.errorMessage).toBe(typed.message);
			expect(events[0]?.diskFull).toMatchObject({ path: file });
			const streamed = records.filter(
				(record): record is { type: string; errorCause?: string } =>
					(record as { type?: unknown }).type === "transcript_write_failed",
			);
			expect(streamed.map((record) => record.errorCause)).toEqual(["disk_full", "disk_full"]);
		},
	);
});
