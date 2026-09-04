import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import {
	type MonitorEvent,
	MonitorRegistry,
	type MonitorSnapshotEntry,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import {
	InvalidTerminalManifestError,
	type RestoreHandlerResult,
	type RestoreHandlers,
	restoreTerminalState,
	stubRestoreHandlers,
} from "../../src/core/extensions/builtin/terminal/restore.ts";
import {
	type ManifestMonitor,
	TerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import {
	bindTerminalManifestWriter,
	createMonitorTool,
	unbindTerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { InvalidSidecarStoreError } from "../../src/core/session-sidecar-store.ts";

interface Fixture {
	writer: TerminalManifestWriter;
	sessionId: string;
	sessionDir: string;
}

let fixtureSeq = 0;

async function makeFixture(): Promise<Fixture> {
	fixtureSeq += 1;
	const sessionId = `manifest-session-${process.pid}-${fixtureSeq}`;
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-terminal-manifest-"));
	const writer = new TerminalManifestWriter({
		session: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
	});
	// The manifest must never resolve inside the repo tree: pin the fake session dir as
	// absolute and prove the store resolved its sidecar path under that exact directory.
	expect(isAbsolute(sessionDir)).toBe(true);
	expect(isAbsolute(writer.store.filePath)).toBe(true);
	expect(writer.store.filePath.startsWith(join(sessionDir, "extensions", "terminal"))).toBe(true);
	return { writer, sessionId, sessionDir };
}

function manifestMonitor(
	overrides: Partial<ManifestMonitor> & Pick<ManifestMonitor, "monitorId" | "durabilityClass">,
): ManifestMonitor {
	return {
		sessionId: "unused",
		description: "watch",
		runtimeKind: "command",
		createdAt: 1,
		expiresAt: null,
		persistent: false,
		suspended: false,
		lastCheckpoint: null,
		deliveryPaused: false,
		wakeCount: 0,
		fireWindow: { startMs: 1, count: 0 },
		...overrides,
	};
}

function countingHandler(seen: string[]): Pick<RestoreHandlers, "restartable-command" | "checkpointed-file"> {
	const handler = (monitor: ManifestMonitor): RestoreHandlerResult => {
		seen.push(monitor.monitorId);
		return { outcome: "restored" };
	};
	return { "restartable-command": handler, "checkpointed-file": handler };
}

class EventSink {
	readonly events: MonitorEvent[] = [];
	readonly #listeners = new Set<(event: MonitorEvent) => void>();

	push(event: MonitorEvent): void {
		this.events.push(event);
		for (const listener of this.#listeners) listener(event);
	}

	waitFor(predicate: (event: MonitorEvent) => boolean, label: string): Promise<MonitorEvent> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#listeners.delete(listener);
				reject(new Error(`Timed out waiting for ${label}`));
			}, 5000);
			const listener = (event: MonitorEvent) => {
				if (!predicate(event)) return;
				clearTimeout(timeout);
				this.#listeners.delete(listener);
				resolve(event);
			};
			this.#listeners.add(listener);
		});
	}
}

describe("terminal manifest writer", () => {
	it("collapses five checkpoint updates inside the debounce window into one write", async () => {
		vi.useFakeTimers();
		try {
			const { writer } = await makeFixture();
			const writeSpy = vi.spyOn(writer.store, "write");
			await writer.recordRegister({
				monitorId: "mon_file1",
				spec: {
					kind: "file",
					description: "wait for artifact",
					path: "out.bin",
					event: "modify",
					timeoutMs: 300_000,
					cwd: "/tmp",
					persistent: true,
				},
			});
			expect(writeSpy).toHaveBeenCalledTimes(1);
			for (let i = 1; i <= 5; i += 1) {
				writer.scheduleCheckpoint("mon_file1", {
					dev: 1,
					ino: i,
					size: 100 + i,
					mtimeMs: 1_000 + i,
					digest: `${100 + i}:digest-${i}`,
					present: true,
				});
				await vi.advanceTimersByTimeAsync(5_000);
			}
			expect(writeSpy).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(30_000);
			await writer.flush();
			expect(writeSpy).toHaveBeenCalledTimes(2);
			const manifest = await writer.store.read();
			expect(manifest?.monitors[0]?.lastCheckpoint).toEqual({
				dev: 1,
				ino: 5,
				size: 105,
				mtimeMs: 1_005,
				digest: "105:digest-5",
				present: true,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles a monitor with exactly one write and removes its manifest entry", async () => {
		const { writer } = await makeFixture();
		const writeSpy = vi.spyOn(writer.store, "write");
		await writer.recordRegister({
			monitorId: "mon_cmd1",
			spec: { kind: "command", description: "tail logs", command: "tail -f app.log", persistent: true },
		});
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect((await writer.store.read())?.monitors).toHaveLength(1);
		await writer.observeMonitorState([]);
		expect(writeSpy).toHaveBeenCalledTimes(2);
		expect((await writer.store.read())?.monitors).toHaveLength(0);
	});

	it("fails closed on a corrupt manifest: typed read error and storeError digest without handler calls", async () => {
		const { writer, sessionId } = await makeFixture();
		await mkdir(dirname(writer.store.filePath), { recursive: true });
		await writeFile(writer.store.filePath, "{ this is not json", "utf8");
		await expect(writer.store.read()).rejects.toBeInstanceOf(InvalidSidecarStoreError);
		await writeFile(
			writer.store.filePath,
			JSON.stringify({ version: 1, sessionId, monitors: "not-an-array", backgroundSessions: [], updatedAt: 1 }),
			"utf8",
		);
		await expect(writer.store.read()).rejects.toBeInstanceOf(InvalidTerminalManifestError);
		const seen: string[] = [];
		const digest = await restoreTerminalState({
			manifest: writer.store,
			handlers: countingHandler(seen),
		});
		expect(digest).toEqual({ restored: 0, lost: 0, expired: 0, muted: 0, attachedElsewhere: 0, storeError: true });
		expect(seen).toEqual([]);
	});

	it("classifies restartable-command and checkpointed-file entries through their stub handler slots as lost", async () => {
		const { writer, sessionId } = await makeFixture();
		await writer.store.write({
			version: 1,
			sessionId,
			monitors: [
				manifestMonitor({
					monitorId: "mon_restart",
					sessionId,
					durabilityClass: "restartable-command",
					persistent: true,
					command: "tail -f app.log",
				}),
				manifestMonitor({
					monitorId: "mon_file",
					sessionId,
					durabilityClass: "checkpointed-file",
					runtimeKind: "file",
					path: "out.bin",
					event: "modify",
					expiresAt: Date.now() + 60_000,
				}),
				manifestMonitor({ monitorId: "mon_ephemeral", sessionId, durabilityClass: "ephemeral" }),
			],
			backgroundSessions: [{ id: "bg-1", command: "echo done", startedAtMs: 5 }],
			updatedAt: 2,
		});
		const digest = await restoreTerminalState({ manifest: writer.store, handlers: stubRestoreHandlers });
		expect(digest).toEqual({ restored: 0, lost: 4, expired: 0, muted: 0, attachedElsewhere: 0, storeError: false });
	});

	it("expires monitors whose expiresAt has passed without calling their handler", async () => {
		const { writer, sessionId } = await makeFixture();
		const now = 5_000_000;
		await writer.store.write({
			version: 1,
			sessionId,
			monitors: [
				manifestMonitor({
					monitorId: "mon_stale",
					sessionId,
					durabilityClass: "checkpointed-file",
					runtimeKind: "file",
					path: "out.bin",
					event: "modify",
					expiresAt: now - 1_000,
				}),
			],
			backgroundSessions: [],
			updatedAt: 3,
		});
		const seen: string[] = [];
		const digest = await restoreTerminalState({
			manifest: writer.store,
			handlers: countingHandler(seen),
			now: () => now,
		});
		expect(digest).toEqual({ restored: 0, lost: 0, expired: 1, muted: 0, attachedElsewhere: 0, storeError: false });
		expect(seen).toEqual([]);
	});

	it("records background start and exit as one write each", async () => {
		const { writer } = await makeFixture();
		const writeSpy = vi.spyOn(writer.store, "write");
		await writer.recordBackgroundStart("bg-1", "echo done", 123);
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect((await writer.store.read())?.backgroundSessions).toEqual([
			{ id: "bg-1", command: "echo done", startedAtMs: 123 },
		]);
		await writer.recordBackgroundExit("bg-1");
		expect(writeSpy).toHaveBeenCalledTimes(2);
		expect((await writer.store.read())?.backgroundSessions).toEqual([]);
	});

	it("re-adopts a restored entry without a write, keeps every persisted field, clears suspended, and counts it as durable", async () => {
		const { writer, sessionId } = await makeFixture();
		const writeSpy = vi.spyOn(writer.store, "write");
		const restored = manifestMonitor({
			monitorId: "mon_readopt",
			sessionId,
			durabilityClass: "checkpointed-file",
			runtimeKind: "file",
			description: "standing artifact watch",
			path: "out.bin",
			event: "modify",
			cwd: "/tmp",
			approvedParent: "/tmp",
			persistent: true,
			suspended: true,
			createdAt: 1_000,
			expiresAt: 9_000,
			lastCheckpoint: { dev: 7, ino: 11, size: 42, mtimeMs: 2_500, digest: "42:abc", present: true },
			deliveryPaused: true,
			wakeCount: 3,
			fireWindow: { startMs: 1_500, count: 2 },
		});
		expect(writer.durableCount()).toBe(0);

		writer.adoptRestored(restored);

		// Re-adoption is recovery, not a transition: it must not write on its own.
		expect(writeSpy).not.toHaveBeenCalled();
		// The cap still holds after a restart because re-adopted durable entries are counted.
		expect(writer.durableCount()).toBe(1);

		// The next persist — any transition — now carries the restored entry instead of erasing it.
		await writer.recordBackgroundStart("bg-after-restore", "echo hi", 123);
		expect(writeSpy).toHaveBeenCalledTimes(1);
		const persisted = (await writer.store.read())?.monitors ?? [];
		expect(persisted).toEqual([{ ...restored, suspended: false }]);
		// Explicitly: the durability deadline set at registration is not extended by a restore.
		expect(persisted[0]?.expiresAt).toBe(9_000);
		expect(persisted[0]?.createdAt).toBe(1_000);
	});

	it("surfaces an error for a snapshot entry missing its stable monitorId instead of skipping it", async () => {
		const { writer } = await makeFixture();
		const writeSpy = vi.spyOn(writer.store, "write");
		const entry: MonitorSnapshotEntry = { id: "watch_1", description: "unidentified", paused: false, startedAtMs: 1 };
		expect(() => writer.observeMonitorState([entry])).toThrow(/monitorId/);
		await writer.flush();
		expect(writeSpy).not.toHaveBeenCalled();
	});
});

describe("terminal manifest spec capture through the monitor tool", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
	});

	afterEach(() => {
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	function makeHarness(fixture: Fixture) {
		const manager = new TerminalManager();
		const sink = new EventSink();
		const registry = new MonitorRegistry((event) => sink.push(event), {
			onChange: (snapshot) => void fixture.writer.observeMonitorState(snapshot),
		});
		const ctx: TerminalToolContext = {
			manager,
			cwd: fixture.sessionDir,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			onMonitorEvent: (event) => sink.push(event),
			monitorRegistry: registry,
			getSessionContext: () =>
				({ sessionManager: { getSessionId: () => fixture.sessionId } }) as unknown as ExtensionContext,
		};
		return { manager, sink, registry, tool: createMonitorTool(ctx) };
	}

	it("registers an ephemeral monitor with exactly one write, durabilityClass ephemeral and expiresAt null", async () => {
		const fixture = await makeFixture();
		bindTerminalManifestWriter(fixture.sessionId, fixture.writer);
		const harness = makeHarness(fixture);
		try {
			const writeSpy = vi.spyOn(fixture.writer.store, "write");
			const result = await harness.tool.execute("manifest-create", {
				description: "quiet watch",
				command: "sleep 30",
			});
			await fixture.writer.flush();
			expect(writeSpy).toHaveBeenCalledTimes(1);
			const manifest = await fixture.writer.store.read();
			expect(manifest?.monitors).toHaveLength(1);
			const entry = manifest?.monitors[0];
			expect(entry?.durabilityClass).toBe("ephemeral");
			expect(entry?.expiresAt).toBe(null);
			expect(entry?.persistent).toBe(false);
			expect(entry?.runtimeKind).toBe("command");
			expect(entry?.command).toBe("sleep 30");
			expect(entry?.monitorId).toBe(result.details?.monitor_id);
			expect(entry?.sessionId).toBe(fixture.sessionId);
		} finally {
			await harness.manager.teardown();
			harness.registry.dispose();
			await fixture.writer.flush();
			unbindTerminalManifestWriter(fixture.sessionId);
		}
	});

	it("emits 500 matching PTY lines without any additional manifest writes", async () => {
		const fixture = await makeFixture();
		bindTerminalManifestWriter(fixture.sessionId, fixture.writer);
		const harness = makeHarness(fixture);
		try {
			const writeSpy = vi.spyOn(fixture.writer.store, "write");
			await harness.tool.execute("manifest-lines", {
				description: "chatty watch",
				command: "seq 1 500; sleep 30",
			});
			await harness.sink.waitFor((event) => event.type === "line" && event.line === "500", "500th monitor line");
			await fixture.writer.flush();
			expect(writeSpy).toHaveBeenCalledTimes(1);
		} finally {
			await harness.manager.teardown();
			harness.registry.dispose();
			await fixture.writer.flush();
			unbindTerminalManifestWriter(fixture.sessionId);
		}
	});
});
