import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointedFileRestoreHandler } from "../../src/core/extensions/builtin/terminal/durable-file.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { type MonitorEvent, MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { restoreTerminalState } from "../../src/core/extensions/builtin/terminal/restore.ts";
import {
	DURABLE_MONITOR_EXPIRY_MS,
	type ManifestMonitor,
	TerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import {
	bindTerminalManifestWriter,
	createMonitorTool,
	type MonitorInput,
	unbindTerminalManifestWriter,
} from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

/**
 * The registry's own digest shape for a file below its 64 KiB sample window: `size:sha256(bytes)`.
 * Recomputed here so the persisted checkpoint is asserted exactly, with no wildcard matcher.
 */
function sampleDigest(content: string): string {
	const bytes = Buffer.from(content);
	return `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * One restart lane: an absolute tmp session dir (never the checkout), a manifest writer with the
 * debounce disabled so a checkpoint is observable without fake timers, and one registry
 * generation at a time — teardown of generation 1 is the "process died" boundary.
 */
class Lane {
	readonly events: MonitorEvent[] = [];
	readonly manager = new TerminalManager();
	registry = new MonitorRegistry((event) => this.events.push(event));
	readonly writer: TerminalManifestWriter;
	readonly sessionId: string;
	readonly root: string;
	readonly sessionDir: string;

	constructor(root: string, sessionDir: string, seq: number) {
		this.root = root;
		this.sessionDir = sessionDir;
		this.sessionId = `durable-file-${process.pid}-${seq}`;
		this.writer = new TerminalManifestWriter({
			session: { getSessionDir: () => sessionDir, getSessionId: () => this.sessionId },
			debounceMs: 1,
		});
		bindTerminalManifestWriter(this.sessionId, this.writer);
	}

	tool() {
		const ctx: TerminalToolContext = {
			manager: this.manager,
			cwd: this.root,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			onMonitorEvent: (event) => this.events.push(event),
			monitorRegistry: this.registry,
			getSessionContext: () =>
				({ sessionManager: { getSessionId: () => this.sessionId } }) as unknown as ExtensionContext,
		};
		return { monitor: createMonitorTool(ctx), kill: createKillBashTool(ctx) };
	}

	/** The restart boundary: drop the live registry, then hand back a fresh one. */
	restart(): MonitorRegistry {
		this.registry.dispose();
		this.events.length = 0;
		this.registry = new MonitorRegistry((event) => this.events.push(event));
		return this.registry;
	}

	handler() {
		return createCheckpointedFileRestoreHandler({
			registry: this.registry,
			writer: this.writer,
			bindMonitorId: (monitorId, runtimeId) => this.manager.bindMonitorId(monitorId, runtimeId),
		});
	}

	restore() {
		return restoreTerminalState({
			manifest: this.writer.store,
			handlers: { "checkpointed-file": this.handler() },
		});
	}

	lines(): string[] {
		return this.events.filter((event) => event.type === "line").map((event) => event.line);
	}

	async dispose(): Promise<void> {
		this.registry.dispose();
		await this.manager.teardown();
		await this.writer.flush();
		unbindTerminalManifestWriter(this.sessionId);
	}
}

let seq = 0;

describe("checkpointed-file durability class", () => {
	let root: string;
	let sessionDir: string;
	let lane: Lane;

	beforeEach(async () => {
		// Absolute tmp dirs only: a monitor lane must never write inside the checkout.
		root = await mkdtemp(join(tmpdir(), "senpi-durable-file-work-"));
		sessionDir = await mkdtemp(join(tmpdir(), "senpi-durable-file-session-"));
		expect(isAbsolute(root)).toBe(true);
		expect(isAbsolute(sessionDir)).toBe(true);
		seq += 1;
		lane = new Lane(root, sessionDir, seq);
		expect(lane.writer.store.filePath.startsWith(join(sessionDir, "extensions", "terminal"))).toBe(true);
	});

	afterEach(async () => {
		await lane.dispose();
		await rm(root, { recursive: true, force: true });
		await rm(sessionDir, { recursive: true, force: true });
	});

	/** Create one persistent file watch through the tool and settle its debounced checkpoint. */
	async function createPersistentWatch(path: string, event: "create" | "modify" = "modify") {
		const created = await lane.tool().monitor.execute("durable-create", {
			description: "durable artifact",
			path,
			event,
			persistent: true,
		} as MonitorInput);
		expect(created.isError, firstText(created)).toBeFalsy();
		await lane.writer.flush();
		return created;
	}

	it("persists class, durable expiry and the record's checkpoint (digest included) on create", async () => {
		const path = join(root, "artifact.bin");
		await writeFile(path, "one");
		const before = Date.now();
		const created = await createPersistentWatch(path);
		const entry = (await lane.writer.store.read())?.monitors[0];
		const live = await stat(path);

		expect(entry?.monitorId).toBe(created.details?.monitor_id);
		expect(entry?.durabilityClass).toBe("checkpointed-file");
		expect(entry?.persistent).toBe(true);
		expect(entry?.path).toBe(path);
		expect(entry?.expiresAt).toBe((entry?.createdAt ?? 0) + DURABLE_MONITOR_EXPIRY_MS);
		expect(entry?.createdAt).toBeGreaterThanOrEqual(before);
		expect(entry?.lastCheckpoint).toEqual({
			dev: live.dev,
			ino: live.ino,
			size: live.size,
			mtimeMs: live.mtimeMs,
			digest: sampleDigest("one"),
			present: true,
		});
	});

	it("reports one created line when a watch on an absent path finds the file after a restart", async () => {
		const path = join(root, "late.txt");
		await createPersistentWatch(path, "create");
		expect((await lane.writer.store.read())?.monitors[0]?.lastCheckpoint?.present).toBe(false);

		lane.restart();
		await writeFile(path, "landed");
		const digest = await lane.restore();

		expect(digest).toEqual({ restored: 1, lost: 0, expired: 0, muted: 0, attachedElsewhere: 0, storeError: false });
		expect(lane.lines()).toEqual([`changed while detached: created ${path}`]);
	});

	it("reports one modified line for a same-size, same-mtime content change (digest only)", async () => {
		const path = join(root, "same-shape.txt");
		// Pin mtime to a whole second first: utimes has coarser resolution than a native write's
		// mtime, so only a pre-pinned timestamp can be restored byte-exactly after the rewrite.
		const pinned = new Date(1_700_000_000_000);
		await writeFile(path, "aaaa");
		await utimes(path, pinned, pinned);
		await createPersistentWatch(path);
		const saved = await stat(path);
		expect(saved.mtimeMs).toBe(pinned.getTime());

		lane.restart();
		await writeFile(path, "bbbb");
		await utimes(path, pinned, pinned);
		const rewritten = await stat(path);
		expect(rewritten.size).toBe(saved.size);
		expect(rewritten.mtimeMs).toBe(saved.mtimeMs);

		const digest = await lane.restore();
		expect(digest.restored).toBe(1);
		expect(lane.lines()).toEqual([`changed while detached: modified ${path}`]);
	});

	it("reports one replaced line and re-checkpoints the new identity when dev/ino differ", async () => {
		const path = join(root, "swapped.txt");
		await writeFile(path, "original");
		await createPersistentWatch(path);
		const saved = (await lane.writer.store.read())?.monitors[0]?.lastCheckpoint;

		lane.restart();
		// Atomic replace, as a real writer (editors, writeAtomic, log rotation) performs it: the
		// replacement is written at a sibling staging path in the same directory (same filesystem,
		// so the rename is atomic) and renamed over the watched path. The original still holds its
		// inode while the staging file is created, and two live files on one filesystem can never
		// share an inode, so the identity swap is GUARANTEED — unlike rm + recreate, where the
		// allocator may hand the freed inode straight back (which is how CI failed).
		const staging = join(root, "swapped.txt.next");
		await writeFile(staging, "replacement");
		const staged = await stat(staging);
		expect(staged.ino).not.toBe(saved?.ino);
		await rename(staging, path);
		const replacement = await stat(path);
		expect(replacement.ino).toBe(staged.ino);
		expect(replacement.ino).not.toBe(saved?.ino);

		const digest = await lane.restore();
		await lane.writer.flush();

		expect(digest.restored).toBe(1);
		expect(lane.lines()).toEqual([`changed while detached: replaced ${path}`]);
		expect((await lane.writer.store.read())?.monitors[0]?.lastCheckpoint).toEqual({
			dev: replacement.dev,
			ino: replacement.ino,
			size: replacement.size,
			mtimeMs: replacement.mtimeMs,
			digest: sampleDigest("replacement"),
			present: true,
		});
	});

	it("emits zero events when the file is untouched across the restart", async () => {
		const path = join(root, "quiet.txt");
		await writeFile(path, "unchanged");
		await createPersistentWatch(path);

		lane.restart();
		const digest = await lane.restore();

		expect(digest).toEqual({ restored: 1, lost: 0, expired: 0, muted: 0, attachedElsewhere: 0, storeError: false });
		expect(lane.events).toEqual([]);
	});

	it("reports lost without re-registering when the watched path is gone", async () => {
		const path = join(root, "vanished.txt");
		await writeFile(path, "here");
		await createPersistentWatch(path);

		lane.restart();
		await rm(path);
		const digest = await lane.restore();

		expect(digest).toEqual({ restored: 0, lost: 1, expired: 0, muted: 0, attachedElsewhere: 0, storeError: false });
		// Nothing was re-registered, so no watch was left behind and no event was manufactured.
		expect(lane.registry.snapshot()).toEqual([]);
		expect(lane.events).toEqual([]);
	});

	it("reports lost and leaves no watch behind when the file is deleted mid-restore", async () => {
		const path = join(root, "racing.txt");
		await writeFile(path, "here");
		await createPersistentWatch(path);
		const saved = (await lane.writer.store.read())?.monitors[0];

		const registry = lane.restart();
		// Force the race the probe cannot close: the file survives the pre-check and is unlinked
		// while the real registerFile runs, so the fresh record comes back present: false.
		const handler = createCheckpointedFileRestoreHandler({
			registry: {
				registerFile: async (options) => {
					await rm(path);
					return registry.registerFile(options);
				},
				fileCheckpoint: (id) => registry.fileCheckpoint(id),
				emitFileLine: (id, line) => registry.emitFileLine(id, line),
				stopFile: (id) => registry.stopFile(id),
			},
			writer: lane.writer,
		});

		const result = await handler(saved as ManifestMonitor);

		expect(result.outcome).toBe("lost");
		expect(result.reason).toContain("gone");
		expect(lane.lines()).toEqual([]);
		expect(registry.snapshot()).toEqual([]);
	});

	it("never restores a non-persistent file monitor and never re-registers it", async () => {
		const path = join(root, "ephemeral.txt");
		await writeFile(path, "one");
		const created = await lane.tool().monitor.execute("ephemeral-create", {
			description: "one-shot artifact",
			path,
			event: "modify",
		} as MonitorInput);
		expect(created.isError, firstText(created)).toBeFalsy();
		await lane.writer.flush();
		expect((await lane.writer.store.read())?.monitors[0]?.durabilityClass).toBe("ephemeral");

		lane.restart();
		await writeFile(path, "two");
		const digest = await lane.restore();

		expect(digest).toEqual({ restored: 0, lost: 1, expired: 0, muted: 0, attachedElsewhere: 0, storeError: false });
		expect(lane.registry.snapshot()).toEqual([]);
		expect(lane.events).toEqual([]);
	});

	it("keeps the mon_ id across the restore and stops the restored watch with kill_bash", async () => {
		const path = join(root, "keeps-id.txt");
		await writeFile(path, "one");
		const created = await createPersistentWatch(path);
		const monitorId = String(created.details?.monitor_id ?? "");
		expect(monitorId).toMatch(/^mon_[0-9A-Z]{16}$/);

		lane.restart();
		const digest = await lane.restore();
		expect(digest.restored).toBe(1);

		const restored = lane.registry.snapshot();
		expect(restored).toHaveLength(1);
		expect(restored[0]?.monitorId).toBe(monitorId);
		// The stable mon_ id now resolves to the FRESH runtime id, not the pre-restart one.
		const runtimeId = restored[0]?.id ?? "";
		expect(runtimeId).toMatch(/^watch_\d+$/);
		expect(lane.manager.resolveId(monitorId)).toBe(runtimeId);

		const killed = await lane.tool().kill.execute("durable-kill", { bash_id: monitorId });
		expect(killed.isError, firstText(killed)).toBeFalsy();
		expect(firstText(killed)).toBe(`Killed ${monitorId}.`);
		expect(lane.registry.snapshot()).toEqual([]);
	});
});
