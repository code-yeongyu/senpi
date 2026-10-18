import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "../harness.ts";

/**
 * A turn whose messages the session file refuses (EACCES; ENOSPC or a removed directory in the
 * field) must surface the failure to the prompt and must not leave those messages in the
 * SessionManager: the next turn's entries would otherwise chain onto parents the file never got.
 */

interface DiskEntry {
	type: string;
	id: string;
	parentId?: string | null;
}

interface LogLine {
	event: string;
	role?: string;
}

const harnesses: Harness[] = [];
const lockedFiles: string[] = [];
afterEach(() => {
	for (const file of lockedFiles.splice(0)) chmodSync(file, 0o644);
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function diskEntries(file: string): DiskEntry[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as DiskEntry)
		.filter((entry) => entry.type !== "session");
}

function loggedWriteFailures(harness: Harness): LogLine[] {
	return readFileSync(join(harness.tempDir, "agent", "logs", "session.log"), "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as LogLine)
		.filter((line) => line.event === "transcript_write_failed");
}

function lockFile(file: string): void {
	chmodSync(file, 0o444);
	lockedFiles.push(file);
}

function unlockFile(file: string): void {
	chmodSync(file, 0o644);
	lockedFiles.splice(lockedFiles.indexOf(file), 1);
}

async function persistedHarness(settings?: HarnessOptions["settings"]) {
	const harness = await createHarness({ persistSession: true, extensionFactories: [], settings });
	harnesses.push(harness);
	return harness;
}

function sessionFileOf(harness: Harness): string {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("test setup: persisted session has no file");
	return file;
}

const roleAndText = (message: { role: string }) => `${message.role}:${getMessageText(message)}`;

describe("a turn whose session writes are refused", () => {
	it("rejects the prompt, keeps the refused messages out of the session, and the next turn chains onto the file", async () => {
		// Given a persisted session whose first turn reached the file
		const harness = await persistedHarness();
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("refused reply"),
			fauxAssistantMessage("third reply"),
		]);
		await harness.session.prompt("first");
		const file = sessionFileOf(harness);
		const lastWritten = harness.sessionManager.getLeafId();

		// When the second turn runs while the file is read-only
		lockFile(file);
		const refused = await harness.session.prompt("second").then(
			() => undefined,
			(error: unknown) => error,
		);
		unlockFile(file);
		// And a third turn runs once the file is writable again
		await harness.session.prompt("third");

		// Then the second prompt reported the refused write and the session is idle again
		expect(refused).toMatchObject({ code: "EACCES" });
		expect(harness.session.isStreaming).toBe(false);
		// And every refused message was published to listeners and logged with its role
		expect(harness.eventsOfType("transcript_write_failed").map((event) => event.role)).toEqual(["user", "assistant"]);
		expect(harness.eventsOfType("transcript_write_failed")[0]?.errorMessage).toContain("EACCES");
		expect(loggedWriteFailures(harness).map((line) => line.role)).toEqual(["user", "assistant"]);
		// And the third turn's user message is a child of the last entry the file received
		const onDisk = diskEntries(file);
		const thirdUser = onDisk.find((entry) => entry.parentId === lastWritten);
		expect(thirdUser).toBeDefined();
		// And every parent named in the file is in the file, with memory matching it exactly
		const diskIds = new Set(onDisk.map((entry) => entry.id));
		expect(onDisk.filter((entry) => entry.parentId && !diskIds.has(entry.parentId))).toEqual([]);
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(onDisk.map((entry) => entry.id));
	});

	it("sends the next turn the model context a reload of the file shows", async () => {
		// Given a persisted session whose second turn the file refused
		const harness = await persistedHarness();
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("refused reply"),
			fauxAssistantMessage("third reply"),
		]);
		await harness.session.prompt("first");
		const file = sessionFileOf(harness);
		lockFile(file);
		await harness.session.prompt("second").catch(() => undefined);
		unlockFile(file);
		const reloaded = SessionManager.open(file).buildSessionContext().messages.map(roleAndText);

		// When the next turn runs
		await harness.session.prompt("third");

		// Then the model saw the reloaded conversation plus the new prompt, without the refused turn
		const sent = harness.faux.getCallLog().at(-1)?.context.messages.map(roleAndText);
		expect(reloaded).toEqual(["user:first", "assistant:first reply"]);
		expect(sent).toEqual([...reloaded, "user:third"]);
	});

	it("reports a continuation run's refused writes as a continuation error", async () => {
		// Given a persisted session with automatic retries
		const harness = await persistedHarness({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
			fauxAssistantMessage("retried reply"),
		]);
		await harness.session.prompt("first");
		const file = sessionFileOf(harness);
		const continuationError = new Promise<string>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "continuation_error") resolve(event.errorMessage);
			});
		});
		// And the file turns read-only once the failed attempt is recorded and the retry starts
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") lockFile(file);
		});

		// When the prompt's retry continuation replies
		await harness.session.prompt("second");

		// Then the continuation reports the reply the file refused
		expect(await continuationError).toContain("EACCES");
		expect(harness.eventsOfType("transcript_write_failed").map((event) => event.role)).toEqual(["assistant"]);
	});

	it("reports once, as a continuation error, a retry that also loses its writes after the prompt's refusal", async () => {
		// Given a persisted session with automatic retries whose file turns read-only before the next prompt
		const harness = await persistedHarness({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
			fauxAssistantMessage("retried reply"),
		]);
		await harness.session.prompt("first");
		lockFile(sessionFileOf(harness));

		// When the prompt's writes are refused and its scheduled retry's reply is refused too
		const refused = await harness.session.prompt("second").then(
			() => undefined,
			(error: unknown) => error,
		);
		await harness.session.waitForSettledSessionWork();

		// Then the prompt reported its own refusal and the retry run reported its loss exactly once
		expect(refused).toMatchObject({ code: "EACCES" });
		expect(harness.faux.state.callCount).toBe(3);
		const continuationErrors = harness.eventsOfType("continuation_error").map((event) => event.errorMessage);
		expect(continuationErrors).toHaveLength(1);
		expect(continuationErrors[0]).toContain("EACCES");
	});
});
