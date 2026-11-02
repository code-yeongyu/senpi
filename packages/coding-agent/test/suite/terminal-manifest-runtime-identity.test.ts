import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManifestWriter } from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

let seq = 0;

async function writerFor() {
	seq += 1;
	const sessionId = `runtime-identity-${process.pid}-${seq}`;
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-manifest-runtime-"));
	createdDirs.push(sessionDir);
	const writer = new TerminalManifestWriter({
		session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
	});
	return { writer, sessionId };
}

const runtime = {
	pid: 4321,
	processGroupId: 4321,
	startedAtMs: 1_790_000_000_000,
	bootAtMs: 1_789_990_000_000,
	argv: ["/bin/sh", "-c", "while true; do date; sleep 5; done"],
} as const;

function v1Monitor(sessionId: string): Record<string, unknown> {
	return {
		monitorId: "mon_LEGACY000000001",
		sessionId,
		description: "legacy entry",
		runtimeKind: "command",
		durabilityClass: "restartable-command",
		command: "cat",
		cwd: tmpdir(),
		createdAt: 1_000,
		expiresAt: 9_999_999_999_999,
		persistent: true,
		suspended: true,
		lastCheckpoint: null,
		deliveryPaused: false,
		fireWindow: { startMs: 1_000, count: 0 },
	};
}

describe("terminal manifest runtime identity (optional fields, version 1)", () => {
	it("parses a v1 manifest written before the runtime fields existed", async () => {
		const { writer, sessionId } = await writerFor();
		await mkdir(dirname(writer.store.filePath), { recursive: true });
		await writeFile(
			writer.store.filePath,
			JSON.stringify({
				version: 1,
				sessionId,
				monitors: [v1Monitor(sessionId)],
				backgroundSessions: [{ id: "bash_1", command: "cat", startedAtMs: 5 }],
				updatedAt: 7,
			}),
			"utf8",
		);
		const state = await writer.store.read();
		expect(state?.monitors[0]?.runtime).toBeUndefined();
		expect(state?.monitors[0]?.deadlineMs).toBeUndefined();
		expect(state?.backgroundSessions[0]?.runtime).toBeUndefined();
		expect(state?.version).toBe(1);
	});

	it("round-trips runtime identity and an ephemeral deadline through the writer", async () => {
		const { writer } = await writerFor();
		await writer.recordRegister({
			monitorId: "mon_EPHEMERAL00001",
			spec: { kind: "command", description: "ci watch", command: "gh pr checks", cwd: tmpdir(), persistent: false },
			runtime,
			deadlineMs: 1_790_000_300_000,
		});
		await writer.recordBackgroundStart("bash_7", "bun dev", 42, runtime);
		const state = await writer.store.read();
		expect(state?.monitors[0]).toMatchObject({ runtime, deadlineMs: 1_790_000_300_000 });
		expect(state?.backgroundSessions[0]).toMatchObject({ id: "bash_7", runtime });
		expect(state?.version).toBe(1);
	});

	it("keeps parsing when an entry carries a key this build does not know", async () => {
		const { writer, sessionId } = await writerFor();
		await mkdir(dirname(writer.store.filePath), { recursive: true });
		await writeFile(
			writer.store.filePath,
			JSON.stringify({
				version: 1,
				sessionId,
				monitors: [{ ...v1Monitor(sessionId), someFutureField: { nested: true } }],
				backgroundSessions: [],
				updatedAt: 7,
			}),
			"utf8",
		);
		const state = await writer.store.read();
		expect(state?.monitors[0]?.monitorId).toBe("mon_LEGACY000000001");
	});

	it("rejects a runtime record whose pid is not a number (fail closed)", async () => {
		const { writer, sessionId } = await writerFor();
		await mkdir(dirname(writer.store.filePath), { recursive: true });
		await writeFile(
			writer.store.filePath,
			JSON.stringify({
				version: 1,
				sessionId,
				monitors: [{ ...v1Monitor(sessionId), runtime: { ...runtime, pid: "4321" } }],
				backgroundSessions: [],
				updatedAt: 7,
			}),
			"utf8",
		);
		await expect(writer.store.read()).rejects.toThrow(/runtime/);
		expect(JSON.parse(await readFile(writer.store.filePath, "utf8")).version).toBe(1);
	});
});
