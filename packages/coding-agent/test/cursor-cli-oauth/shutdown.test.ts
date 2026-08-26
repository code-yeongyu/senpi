import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CursorCliChildRegistry,
	CursorCliGenerationGuard,
	registerCursorCliShutdownSafety,
	spawnCursorCliTracked,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/diagnostics.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(TEST_DIRECTORY, "../fixtures/fake-cursor-agent.mjs");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "cursor-cli-shutdown-"));
	temporaryDirectories.push(directory);
	return directory;
}

/**
 * A grandchild-capable executable: a keep-alive leader that re-execs the real
 * fixture with the grandchild scenario, so the leader is still alive when the
 * shutdown handler fires - the exact mid-run interruption shape.
 */
function grandchildExecutable(directory: string): { executable: string; pidFile: string } {
	const copiedFixture = join(directory, "fake-cursor-agent.mjs");
	const executable = join(directory, "cursor-agent");
	const dump = join(directory, "invocation.json");
	const pidFile = join(directory, "grandchild.pid");
	copyFileSync(FIXTURE, copiedFixture);
	const source = `#!${process.execPath}\nimport { spawn } from "node:child_process";\nspawn(process.execPath, [${JSON.stringify(copiedFixture)}, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, FAKE_CURSOR_ARGV_DUMP: ${JSON.stringify(dump)}, FAKE_CURSOR_SCENARIO: "grandchild", FAKE_CURSOR_GRANDCHILD_PID_FILE: ${JSON.stringify(pidFile)} } });\nsetInterval(() => {}, 1000);\n`;
	writeFileSync(executable, source, { mode: 0o700 });
	chmodSync(executable, 0o700);
	return { executable, pidFile };
}

type SessionHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

function capturePi(): { pi: ExtensionAPI; handlers: Map<string, SessionHandler> } {
	const handlers = new Map<string, SessionHandler>();
	const pi = {
		on: (event: string, handler: SessionHandler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function liveContext(): ExtensionContext {
	return { isIdle: () => true } as unknown as ExtensionContext;
}

/**
 * Wait for the fixture's atomically-renamed pid file. Call BEFORE spawning
 * the process tree that writes it. Presence on disk - checked on a short
 * bounded poll - is the signal of record: fs.watch is only a best-effort
 * wake-up here because macOS event delivery inside a vitest worker has been
 * observed to drop every event for a freshly created temp directory (the
 * file sat on disk while the old event-only wait burned its whole deadline).
 */
function waitForPidFile(pidFile: string): Promise<number> {
	return new Promise<number>((resolvePid, rejectPid) => {
		const watcher = watch(dirname(pidFile));
		let settled = false;
		const finish = (outcome: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearInterval(poll);
			watcher.close();
			outcome();
		};
		const tryRead = () => {
			if (settled || !existsSync(pidFile)) return;
			const contents = readFileSync(pidFile, "utf8").trim();
			if (contents === "") return;
			finish(() => resolvePid(Number(contents)));
		};
		const poll = setInterval(tryRead, 50);
		const deadline = setTimeout(() => {
			finish(() =>
				rejectPid(
					new Error(
						`fixture did not report its grandchild (directory: [${readdirSync(dirname(pidFile)).join(", ")}])`,
					),
				),
			);
		}, 10_000);
		watcher.on("change", tryRead);
		watcher.on("error", tryRead);
		tryRead();
	});
}

function assertDead(pid: number): void {
	expect(() => process.kill(pid, 0)).toThrow();
}

async function waitForDeath(pid: number, deadlineMs = 5_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolveTick) => setTimeout(resolveTick, 25));
	}
	throw new Error(`process ${pid} survived the shutdown grace window`);
}

afterEach(() => {
	delete process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cursor CLI shutdown safety", () => {
	it("kills the live child and its grandchild when session_shutdown fires mid-run", async () => {
		const directory = temporaryDirectory();
		const fixture = grandchildExecutable(directory);
		const registry = new CursorCliChildRegistry();
		const generation = new CursorCliGenerationGuard();
		const { pi, handlers } = capturePi();
		registerCursorCliShutdownSafety(pi, { generation, registry });
		const shutdown = handlers.get("session_shutdown");
		if (!shutdown) throw new Error("session_shutdown handler was not registered");
		expect(handlers.has("session_extensions_removed")).toBe(true);

		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;
		const pendingGrandchildPid = waitForPidFile(fixture.pidFile);
		const handle = spawnCursorCliTracked(
			{
				prompt: "grandchild scenario",
				model: "fake-model",
				accountHome: join(directory, "account-home"),
				cwd: directory,
			},
			registry,
		);
		const grandchildPid = await pendingGrandchildPid;
		expect(registry.livePids()).toContain(handle.pid);

		await shutdown({ type: "session_shutdown", reason: "reload" }, liveContext());
		const outcome = await handle.completed;

		expect(outcome.type).toBe("aborted");
		assertDead(handle.pid);
		await waitForDeath(grandchildPid);
		assertDead(grandchildPid);
		expect(generation.isRetired()).toBe(true);
		expect(registry.livePids()).toEqual([]);
	});

	it("is idempotent when shutdown fires twice", async () => {
		const directory = temporaryDirectory();
		const fixture = grandchildExecutable(directory);
		const registry = new CursorCliChildRegistry();
		const generation = new CursorCliGenerationGuard();
		const { pi, handlers } = capturePi();
		registerCursorCliShutdownSafety(pi, { generation, registry });
		const shutdown = handlers.get("session_shutdown");
		if (!shutdown) throw new Error("session_shutdown handler was not registered");

		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;
		const pendingGrandchildPid = waitForPidFile(fixture.pidFile);
		const handle = spawnCursorCliTracked(
			{
				prompt: "grandchild scenario",
				model: "fake-model",
				accountHome: join(directory, "account-home"),
				cwd: directory,
			},
			registry,
		);
		const grandchildPid = await pendingGrandchildPid;

		await shutdown({ type: "session_shutdown", reason: "quit" }, liveContext());
		await handle.completed;
		// Second fire must be a harmless no-op, not a throw.
		await shutdown({ type: "session_shutdown", reason: "quit" }, liveContext());

		assertDead(handle.pid);
		await waitForDeath(grandchildPid);
		assertDead(grandchildPid);
		expect(registry.livePids()).toEqual([]);
	});

	it("fences a pending continuation whose generation was replaced by a reload", async () => {
		const generation = new CursorCliGenerationGuard();
		const drops: Array<{ description: string; reason: string }> = [];
		generation.onDropped((description, reason) => drops.push({ description, reason }));
		const accesses: string[] = [];
		const ctx = new Proxy(
			{},
			{
				get(_target, property) {
					accesses.push(String(property));
					if (property === "isIdle") return () => true;
					return undefined;
				},
			},
		) as unknown as ExtensionContext;
		const work = vi.fn(async () => "completed-value");

		const pending = generation.defer(ctx, work, 60_000);
		const { pi, handlers } = capturePi();
		registerCursorCliShutdownSafety(pi, { generation, registry: new CursorCliChildRegistry() });
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, liveContext());

		const outcome = await pending.fire();

		expect(outcome.status).toBe("dropped");
		expect(work).not.toHaveBeenCalled();
		expect(drops).toEqual([{ description: expect.any(String), reason: expect.stringContaining("retired") }]);
		// The retired flag short-circuits before any context probe: zero access.
		expect(accesses).toEqual([]);
	});

	it("probes and fences a retired context on a still-live generation", async () => {
		const generation = new CursorCliGenerationGuard();
		const retiredCtx = {
			isIdle: () => {
				throw new Error("stale extension generation after reload");
			},
		} as unknown as ExtensionContext;
		const work = vi.fn(async () => "never");

		const outcome = await generation.runFenced(retiredCtx, work);

		expect(outcome.status).toBe("dropped");
		expect(work).not.toHaveBeenCalled();
	});

	it("runs fenced work on a live generation", async () => {
		const generation = new CursorCliGenerationGuard();
		const outcome = await generation.runFenced(liveContext(), async () => 42);

		expect(outcome).toEqual({ status: "completed", value: 42 });
	});

	it("cancels tracked timers on shutdown and never arms one afterwards", async () => {
		vi.useFakeTimers();
		try {
			const generation = new CursorCliGenerationGuard();
			const fired = vi.fn();
			const healthy = vi.fn();
			generation.setTrackedTimeout(healthy, 10);

			const { pi, handlers } = capturePi();
			registerCursorCliShutdownSafety(pi, { generation, registry: new CursorCliChildRegistry() });
			await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, liveContext());

			generation.setTrackedTimeout(fired, 10);
			vi.advanceTimersByTime(10_000);

			expect(healthy).not.toHaveBeenCalled();
			expect(fired).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("fires tracked timers while the generation is live", async () => {
		vi.useFakeTimers();
		try {
			const generation = new CursorCliGenerationGuard();
			const fired = vi.fn();
			generation.setTrackedTimeout(fired, 10);
			vi.advanceTimersByTime(10);
			expect(fired).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
