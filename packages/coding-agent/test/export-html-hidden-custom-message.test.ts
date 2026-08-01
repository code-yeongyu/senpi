import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

async function sessionWithHiddenCustomMessage(): Promise<{ sessionFile: string; sessionManager: SessionManager }> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-export-hidden-custom-"));
	tempDirs.push(dir);
	const sessionFile = join(dir, "session.jsonl");
	const timestamp = "2026-08-01T00:00:00.000Z";
	await writeFile(
		sessionFile,
		[
			{
				type: "session",
				version: 3,
				id: "session-hidden-custom-message",
				timestamp,
				cwd: dir,
			},
			{
				type: "message",
				id: "root-entry",
				parentId: null,
				timestamp,
				message: { role: "user", content: "Keep the tree topology", timestamp: Date.parse(timestamp) },
			},
			{
				type: "custom_message",
				id: "hidden-entry",
				parentId: "root-entry",
				timestamp,
				customType: "test.hidden",
				content: "PRIVATE_CUSTOM_MESSAGE_CONTENT",
				details: { secret: "PRIVATE_CUSTOM_MESSAGE_DETAILS" },
				display: false,
			},
			{
				type: "custom",
				id: "hidden-state",
				parentId: "hidden-entry",
				timestamp,
				customType: "compaction.todo-snapshot",
				data: { secret: "PRIVATE_CUSTOM_STATE_DATA" },
			},
			{
				type: "message",
				id: "child-entry",
				parentId: "hidden-state",
				timestamp,
				message: { role: "user", content: "Child of hidden entry", timestamp: Date.parse(timestamp) },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
		"utf8",
	);
	return { sessionFile, sessionManager: SessionManager.open(sessionFile) };
}

async function exportedSessionData(outputPath: string): Promise<{ entries: Array<Record<string, unknown>> }> {
	const html = await readFile(outputPath, "utf8");
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]*)<\/script>/)?.[1];
	if (encoded === undefined) throw new Error("exported HTML did not contain session data");
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { entries: Array<Record<string, unknown>> };
}

function expectHiddenCustomMessageToBeSanitized(data: { entries: Array<Record<string, unknown>> }): void {
	const hidden = data.entries.find((entry) => entry.id === "hidden-entry");
	const hiddenState = data.entries.find((entry) => entry.id === "hidden-state");
	const child = data.entries.find((entry) => entry.id === "child-entry");

	expect(data.entries).toHaveLength(4);
	expect(hidden).toMatchObject({
		type: "custom_message",
		id: "hidden-entry",
		parentId: "root-entry",
		customType: "test.hidden",
		content: "",
		display: false,
	});
	expect(hidden).not.toHaveProperty("details");
	expect(hiddenState).toMatchObject({
		type: "custom",
		id: "hidden-state",
		parentId: "hidden-entry",
		customType: "compaction.todo-snapshot",
	});
	expect(hiddenState).not.toHaveProperty("data");
	expect(child).toMatchObject({ id: "child-entry", parentId: "hidden-state" });
	expect(JSON.stringify(data)).not.toContain("PRIVATE_CUSTOM_MESSAGE_");
	expect(JSON.stringify(data)).not.toContain("PRIVATE_CUSTOM_STATE_DATA");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("export HTML hidden custom messages", () => {
	it("sanitizes hidden custom-message content and details from session-manager exports", async () => {
		const { sessionManager, sessionFile } = await sessionWithHiddenCustomMessage();
		const outputPath = join(dirname(sessionFile), "session-manager-export.html");

		await exportSessionToHtml(sessionManager, undefined, { outputPath });

		expectHiddenCustomMessageToBeSanitized(await exportedSessionData(outputPath));
	});

	it("sanitizes hidden custom-message content and details from file exports", async () => {
		const { sessionFile } = await sessionWithHiddenCustomMessage();
		const outputPath = join(dirname(sessionFile), "file-export.html");

		await exportFromFile(sessionFile, { outputPath });

		expectHiddenCustomMessageToBeSanitized(await exportedSessionData(outputPath));
	});
});
