import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManifestMonitor } from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import { TerminalManifestWriter } from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

let seq = 0;

async function writerFor(): Promise<{ writer: TerminalManifestWriter; sessionId: string; sessionDir: string }> {
	seq += 1;
	const sessionId = `hygiene-${process.pid}-${seq}`;
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-manifest-hygiene-"));
	createdDirs.push(sessionDir);
	const writer = new TerminalManifestWriter({
		session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
	});
	return { writer, sessionId, sessionDir };
}

const persistentSpec = (description: string) =>
	({ kind: "command", description, command: "cat", cwd: tmpdir(), persistent: true }) as const;

describe("terminal manifest hygiene", () => {
	it("never leaves an empty manifest: the last background exit removes the file", async () => {
		const { writer, sessionDir, sessionId } = await writerFor();
		const path = join(sessionDir, "extensions", "terminal", `${sessionId}.json`);
		await writer.recordBackgroundStart("bash_1", "sleep 30", 1_000);
		expect(existsSync(path)).toBe(true);
		await writer.recordBackgroundExit("bash_1");
		expect(existsSync(path)).toBe(false);
	});

	it("recordShutdown with nothing live writes nothing", async () => {
		const { writer, sessionDir, sessionId } = await writerFor();
		const path = join(sessionDir, "extensions", "terminal", `${sessionId}.json`);
		await writer.recordShutdown();
		expect(existsSync(path)).toBe(false);
		expect(existsSync(join(sessionDir, "extensions", "terminal"))).toBe(false);
	});

	it("recordShutdown with a live monitor still persists it as suspended", async () => {
		const { writer, sessionDir, sessionId } = await writerFor();
		const path = join(sessionDir, "extensions", "terminal", `${sessionId}.json`);
		await writer.recordRegister({ monitorId: "mon_A", spec: persistentSpec("a") });
		await writer.recordShutdown();
		const persisted = JSON.parse(await readFile(path, "utf8")) as { monitors: ManifestMonitor[] };
		expect(persisted.monitors.map((entry) => [entry.monitorId, entry.suspended])).toEqual([["mon_A", true]]);
	});

	it("seedFromDisk adopts the on-disk entries without writing, so the next transition keeps them", async () => {
		const { writer, sessionDir, sessionId } = await writerFor();
		const path = join(sessionDir, "extensions", "terminal", `${sessionId}.json`);
		await writer.recordRegister({ monitorId: "mon_A", spec: persistentSpec("a") });
		await writer.recordBackgroundStart("bash_9", "cat", 5_000);
		const before = await readFile(path, "utf8");

		const reloaded = new TerminalManifestWriter({
			session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
		});
		await reloaded.seedFromDisk();
		expect(await readFile(path, "utf8")).toBe(before);
		expect(reloaded.durableCount()).toBe(1);

		await reloaded.recordRegister({ monitorId: "mon_B", spec: persistentSpec("b") });
		const persisted = JSON.parse(await readFile(path, "utf8")) as {
			monitors: ManifestMonitor[];
			backgroundSessions: Array<{ id: string }>;
		};
		expect(persisted.monitors.map((entry) => entry.monitorId).sort()).toEqual(["mon_A", "mon_B"]);
		expect(persisted.backgroundSessions.map((entry) => entry.id)).toEqual(["bash_9"]);
	});

	it("seedFromDisk skips entries the previous generation left suspended", async () => {
		const { writer, sessionDir, sessionId } = await writerFor();
		await writer.recordRegister({ monitorId: "mon_A", spec: persistentSpec("a") });
		await writer.recordShutdown();
		const reloaded = new TerminalManifestWriter({
			session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
		});
		await reloaded.seedFromDisk();
		expect(reloaded.durableCount()).toBe(0);
	});
});
