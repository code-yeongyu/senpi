import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHandoverParkedSessions, recordHandoverParkedSession } from "../src/modes/rpc/host-handover-parked.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hhp-"));
	dirs.push(dir);
	return dir;
}

function entryFile(daemonDir: string, sessionPath: string): string {
	const name = `${createHash("sha256").update(sessionPath, "utf8").digest("hex").slice(0, 16)}.json`;
	return join(daemonDir, "handover-parked", name);
}

describe("host-handover-parked record reads", () => {
	it("drops a corrupt (unparseable) entry file and keeps going", async () => {
		const dir = scratch();
		const sessionPath = join(dir, "corrupt.jsonl");
		const file = entryFile(dir, sessionPath);
		await mkdir(join(dir, "handover-parked"), { recursive: true });
		await writeFile(file, "{ not json", "utf8");
		expect(await readHandoverParkedSessions(dir)).toEqual([]);
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a well-formed entry written by another version (shape mismatch is not corrupt)", async () => {
		const dir = scratch();
		const sessionPath = join(dir, "other.jsonl");
		const file = entryFile(dir, sessionPath);
		await mkdir(join(dir, "handover-parked"), { recursive: true });
		await writeFile(file, `${JSON.stringify({ future: true, sessionPath: 42 })}\n`, "utf8");
		expect(await readHandoverParkedSessions(dir)).toEqual([]);
		await expect(stat(file)).resolves.toBeDefined();
	});

	it("round-trips a recorded entry", async () => {
		const dir = scratch();
		const sessionPath = join(dir, "session.jsonl");
		await recordHandoverParkedSession(dir, {
			sessionPath,
			durableSessionId: "29510000-0000-4000-8000-000000000010",
			retainOnDisconnect: true,
			cwd: dir,
		});
		const entries = await readHandoverParkedSessions(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ sessionPath, durableSessionId: "29510000-0000-4000-8000-000000000010" });
	});

	it("round-trips the session's preset, prompt surface and browser engine (senpi#3364)", async () => {
		const dir = scratch();
		const sessionPath = join(dir, "preset.jsonl");
		await recordHandoverParkedSession(dir, {
			sessionPath,
			retainOnDisconnect: true,
			permissionPreset: "ask",
			promptSurface: "app",
			browserEngine: "builtin",
		});
		expect(await readHandoverParkedSessions(dir)).toEqual([
			expect.objectContaining({
				sessionPath,
				permissionPreset: "ask",
				promptSurface: "app",
				browserEngine: "builtin",
			}),
		]);
	});

	it("keeps, but does not return, an entry whose prompt surface this version does not know", async () => {
		const dir = scratch();
		const sessionPath = join(dir, "future.jsonl");
		const file = entryFile(dir, sessionPath);
		await mkdir(join(dir, "handover-parked"), { recursive: true });
		await writeFile(
			file,
			`${JSON.stringify({ sessionPath, retainOnDisconnect: true, promptSurface: "hologram" })}\n`,
			"utf8",
		);
		expect(await readHandoverParkedSessions(dir)).toEqual([]);
		await expect(stat(file)).resolves.toBeDefined();
	});

	it("keeps, but does not return, an entry whose permission preset this version does not know", async () => {
		const dir = scratch();
		const sessionPath = join(dir, "future-preset.jsonl");
		const file = entryFile(dir, sessionPath);
		await mkdir(join(dir, "handover-parked"), { recursive: true });
		await writeFile(
			file,
			`${JSON.stringify({ sessionPath, retainOnDisconnect: true, permissionPreset: "future-preset" })}\n`,
			"utf8",
		);
		expect(await readHandoverParkedSessions(dir)).toEqual([]);
		await expect(stat(file)).resolves.toBeDefined();
	});
});
