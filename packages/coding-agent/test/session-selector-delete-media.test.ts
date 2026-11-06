import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSessionStoreMedium } from "../src/core/session-store/default-store-path.ts";
import { deleteSessionFile } from "../src/modes/interactive/components/session-selector.ts";
import { persistToolImage } from "../src/modes/rpc/tool-media-store.ts";

const SESSION_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

let sessionDir: string;
let sessionFile: string;
beforeEach(() => {
	sessionDir = mkdtempSync(join(tmpdir(), "senpi-selector-media-"));
	sessionFile = join(sessionDir, `2026-10-03T00-00-00-000Z_${SESSION_ID}.jsonl`);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: SESSION_ID })}\n`);
});
afterEach(() => {
	for (const path of [join(sessionDir, "media"), sessionDir]) {
		try {
			chmodSync(path, 0o700);
		} catch {
			// Already gone.
		}
	}
	rmSync(sessionDir, { recursive: true, force: true });
});

function storeImage(): string {
	const outcome = persistToolImage(
		{ sessionDir, durableSessionId: SESSION_ID },
		{ toolCallId: "call_1", contentIndex: 0 },
		{ data: PNG, mimeType: "image/png" },
	);
	if (!("path" in outcome)) throw new Error("image was not stored");
	return outcome.path;
}

describe("deleting a session from the selector", () => {
	it("removes the session's images with the session file", async () => {
		const image = storeImage();

		const result = await deleteSessionFile(sessionFile);

		expect(result.ok).toBe(true);
		expect(result.mediaError).toBeUndefined();
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(image)).toBe(false);
	});

	it("removes images whose folders were made read-only, as a Windows read-only attribute does", async () => {
		const image = storeImage();
		chmodSync(join(image, ".."), 0o500);

		const result = await deleteSessionFile(sessionFile);

		expect(result.mediaError).toBeUndefined();
		expect(existsSync(image)).toBe(false);
	});

	it.skipIf(runningAsRoot)("reports images it could not remove instead of claiming a clean delete", async () => {
		storeImage();
		mkdirSync(join(sessionDir, "media"), { recursive: true });
		chmodSync(join(sessionDir, "media"), 0o500);

		const result = await deleteSessionFile(sessionFile);

		expect(existsSync(sessionFile)).toBe(false);
		expect(result.ok).toBe(true);
		expect(result.mediaError).toContain(join(sessionDir, "media", SESSION_ID));
	});

	// #5991 review: on Bun every entry of a session is also in its durable store; deleting the session must not keep it.
	it("removes the session's durable store, and only that project's, with the session file", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-selector-store-"));
		try {
			const medium = defaultSessionStoreMedium(agentDir, sessionDir, SESSION_ID);
			const otherProject = defaultSessionStoreMedium(agentDir, join(agentDir, "other-project"), SESSION_ID);
			for (const path of [medium, otherProject]) {
				mkdirSync(path, { recursive: true });
				writeFileSync(join(path, "store.sqlite"), "entries");
			}

			const result = await deleteSessionFile(sessionFile, agentDir);

			expect(result.ok).toBe(true);
			expect(result.mediaError).toBeUndefined();
			expect(existsSync(medium)).toBe(false);
			expect(existsSync(join(otherProject, "store.sqlite"))).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("leaves a session that is not stored in the selector's directory alone", async () => {
		const result = await deleteSessionFile(join(sessionDir, "missing.jsonl"));

		expect(result.mediaError).toBeUndefined();
	});
});
