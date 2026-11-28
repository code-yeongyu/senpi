import * as childProcess from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSessionFile } from "../src/modes/interactive/components/session-selector.ts";
import { persistToolImage } from "../src/modes/rpc/tool-media-store.ts";

vi.mock("node:child_process", { spy: true });

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
	vi.mocked(childProcess.spawnSync).mockReset();
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
	it.each([false, true])("keeps image bytes recoverable when trash refuses media: %s (#6608)", async (refuseMedia) => {
		const image = storeImage();
		const media = join(sessionDir, "media", SESSION_ID);
		const bin = join(sessionDir, "test-trash");
		mkdirSync(bin);
		vi.mocked(childProcess.spawnSync).mockImplementation((_cmd, args) => {
			const path = Array.isArray(args) ? args.at(-1) : undefined;
			if (path !== sessionFile && path !== media) throw new Error(`unexpected trash path: ${path}`);
			const refused = refuseMedia && path === media;
			if (!refused) renameSync(path, join(bin, basename(path)));
			return {
				pid: 0,
				output: [],
				stdout: "",
				stderr: refused ? "refused media" : "",
				status: refused ? 1 : 0,
				signal: null,
			};
		});
		const result = await deleteSessionFile(sessionFile);
		expect(result).toMatchObject({ ok: true, method: "trash" });
		renameSync(join(bin, basename(sessionFile)), sessionFile);
		if (refuseMedia) {
			expect(result.mediaError).toContain(media);
		} else {
			expect(result.mediaError).toBeUndefined();
			renameSync(join(bin, SESSION_ID), media);
		}
		expect(readFileSync(image).toString("base64")).toBe(PNG);
	});

	it("permanently removes images when the session itself falls back to unlink", async () => {
		const image = storeImage();
		vi.mocked(childProcess.spawnSync).mockReturnValue({
			pid: 0,
			output: [],
			stdout: "",
			stderr: "trash unavailable",
			status: 1,
			signal: null,
		});

		const result = await deleteSessionFile(sessionFile);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("unlink");
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

	it("leaves a session that is not stored in the selector's directory alone", async () => {
		const result = await deleteSessionFile(join(sessionDir, "missing.jsonl"));

		expect(result.mediaError).toBeUndefined();
	});
});
