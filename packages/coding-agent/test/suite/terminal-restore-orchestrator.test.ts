import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processBootAtMs } from "../../src/core/extensions/builtin/terminal/process-identity.ts";
import {
	type RestoreContext,
	type RestoreHandlerResult,
	restoreTerminalState,
} from "../../src/core/extensions/builtin/terminal/restore.ts";
import type { ManifestMonitor } from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import { TerminalManifestWriter } from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let seq = 0;
const NOW = 1_790_000_000_000;

async function manifestWith(
	monitors: readonly Record<string, unknown>[],
	backgroundSessions: readonly Record<string, unknown>[] = [],
	updatedAt = NOW - 600_000,
) {
	seq += 1;
	const sessionId = `orchestrator-${process.pid}-${seq}`;
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-restore-orchestrator-"));
	cleanups.push(() => rm(sessionDir, { recursive: true, force: true }));
	const writer = new TerminalManifestWriter({
		session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
	});
	await mkdir(dirname(writer.store.filePath), { recursive: true });
	await writeFile(
		writer.store.filePath,
		JSON.stringify({ version: 1, sessionId, monitors, backgroundSessions, updatedAt }),
		"utf8",
	);
	return { writer, sessionId, sessionDir };
}

function monitor(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		monitorId: "mon_DEFAULT00000000",
		sessionId: "s",
		description: "watch",
		runtimeKind: "command",
		durabilityClass: "restartable-command",
		command: "cat",
		cwd: tmpdir(),
		createdAt: NOW - 3_600_000,
		expiresAt: NOW + 86_400_000,
		persistent: true,
		suspended: true,
		lastCheckpoint: null,
		deliveryPaused: false,
		fireWindow: { startMs: NOW - 3_600_000, count: 0 },
		...overrides,
	};
}

describe("restore orchestrator", () => {
	it("runs every durable handler concurrently instead of one after another", async () => {
		const entries = Array.from({ length: 5 }, (_, index) => monitor({ monitorId: `mon_CONCURRENT000000${index}` }));
		const { writer } = await manifestWith(entries);
		let inFlight = 0;
		let maxInFlight = 0;
		const handler = async (): Promise<RestoreHandlerResult> => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => setImmediate(resolve));
			inFlight -= 1;
			return { outcome: "restored" };
		};
		const digest = await restoreTerminalState({
			manifest: writer.store,
			handlers: { "restartable-command": handler },
			now: () => NOW,
		});
		expect(maxInFlight).toBe(5);
		expect(digest.restored).toBe(5);
	});

	it("hands an ephemeral watch with time left to its kind's handler with the remaining time", async () => {
		const { writer } = await manifestWith([
			monitor({
				monitorId: "mon_EPHEMERALLIVE01",
				durabilityClass: "ephemeral",
				persistent: false,
				expiresAt: null,
				deadlineMs: NOW + 45_000,
			}),
		]);
		const seen: Array<[string, RestoreContext]> = [];
		const digest = await restoreTerminalState({
			manifest: writer.store,
			handlers: {
				"restartable-command": (entry: ManifestMonitor, context: RestoreContext) => {
					seen.push([entry.monitorId, context]);
					return { outcome: "restored" };
				},
			},
			now: () => NOW,
		});
		expect(seen).toEqual([["mon_EPHEMERALLIVE01", expect.objectContaining({ remainingMs: 45_000 })]]);
		expect(digest.restored).toBe(1);
	});

	it("reports an ephemeral watch whose deadline passed while detached as lost, with that reason", async () => {
		const { writer } = await manifestWith([
			monitor({
				monitorId: "mon_EPHEMERALGONE01",
				durabilityClass: "ephemeral",
				persistent: false,
				expiresAt: null,
				deadlineMs: NOW - 1,
			}),
		]);
		const digest = await restoreTerminalState({ manifest: writer.store, now: () => NOW });
		expect(digest.results).toEqual([
			expect.objectContaining({
				monitorId: "mon_EPHEMERALGONE01",
				outcome: "lost",
				reason: "deadline passed while detached",
			}),
		]);
	});

	it("carries every monitor's id, kind, outcome and reason in the results", async () => {
		const { writer } = await manifestWith([
			monitor({ monitorId: "mon_RESULTRESTORED1", description: "kept" }),
			monitor({ monitorId: "mon_RESULTLOST0001", description: "gone", command: "sh /tmp/gone.sh" }),
			monitor({ monitorId: "mon_RESULTEXPIRED1", description: "old", expiresAt: NOW - 5 }),
		]);
		const digest = await restoreTerminalState({
			manifest: writer.store,
			handlers: {
				"restartable-command": (entry: ManifestMonitor) =>
					entry.monitorId === "mon_RESULTLOST0001"
						? { outcome: "lost", reason: "exited 127 in 12ms: sh: /tmp/gone.sh: No such file" }
						: { outcome: "restored" },
			},
			now: () => NOW,
		});
		const byId = Object.fromEntries(digest.results.map((result) => [result.monitorId, result]));
		expect(byId.mon_RESULTRESTORED1).toMatchObject({ outcome: "restored", kind: "command", description: "kept" });
		expect(byId.mon_RESULTLOST0001).toMatchObject({
			outcome: "lost",
			reason: "exited 127 in 12ms: sh: /tmp/gone.sh: No such file",
			command: "sh /tmp/gone.sh",
		});
		expect(byId.mon_RESULTEXPIRED1).toMatchObject({ outcome: "expired" });
	});

	it("bounds the downtime by the newest session activity recorded before this process started", async () => {
		const { writer, sessionDir, sessionId } = await manifestWith([monitor({})], [], NOW - 3_600_000);
		const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
		const lastBeforeRestart = new Date(NOW - 120_000).toISOString();
		const afterRestart = new Date(NOW - 1_000).toISOString();
		await writeFile(
			sessionFile,
			`${JSON.stringify({ type: "message", timestamp: new Date(NOW - 900_000).toISOString() })}\n${JSON.stringify({ type: "message", timestamp: lastBeforeRestart })}\n${JSON.stringify({ type: "custom", timestamp: afterRestart })}\n`,
			"utf8",
		);
		const digest = await restoreTerminalState({
			manifest: writer.store,
			handlers: { "restartable-command": () => ({ outcome: "restored" }) },
			now: () => NOW,
			sessionFile,
			processStartedAtMs: NOW - 10_000,
		});
		expect(digest.downtimeMs).toBe(120_000);
	});

	it("passes the downtime bound to every handler", async () => {
		const { writer } = await manifestWith([monitor({})], [], NOW - 300_000);
		const contexts: RestoreContext[] = [];
		await restoreTerminalState({
			manifest: writer.store,
			handlers: {
				"restartable-command": (_entry: ManifestMonitor, context: RestoreContext) => {
					contexts.push(context);
					return { outcome: "restored" };
				},
			},
			now: () => NOW,
		});
		expect(contexts).toEqual([expect.objectContaining({ downtimeMs: 300_000 })]);
	});

	it.runIf(process.platform !== "win32")(
		"tells a still-running background session from one that exited, by identity",
		async () => {
			const child = spawn("sleep", ["30"], { stdio: "ignore" });
			const startedAtMs = Date.now();
			cleanups.push(() => {
				child.kill("SIGKILL");
			});
			if (child.pid === undefined) throw new Error("spawn produced no pid");
			const alive = { pid: child.pid, startedAtMs, bootAtMs: processBootAtMs(), argv: ["sleep", "30"] };
			const dead = { pid: 2_147_000_000, startedAtMs, bootAtMs: processBootAtMs(), argv: ["sleep", "30"] };
			const { writer } = await manifestWith(
				[],
				[
					{ id: "bash_3", command: "sleep 30", startedAtMs, runtime: alive },
					{ id: "bash_5", command: "sleep 30", startedAtMs, runtime: dead },
					{ id: "bash_7", command: "legacy", startedAtMs },
				],
			);
			const digest = await restoreTerminalState({ manifest: writer.store });
			expect(digest.backgroundSessions).toEqual([
				{ id: "bash_3", command: "sleep 30", outcome: "running", pid: child.pid },
				{ id: "bash_5", command: "sleep 30", outcome: "exited" },
				{ id: "bash_7", command: "legacy", outcome: "exited" },
			]);
		},
	);
});
