import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRestartableCommandHandler } from "../../src/core/extensions/builtin/terminal/durable-command.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { type MonitorEvent, MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { ChildProcessIdentity } from "../../src/core/extensions/builtin/terminal/process-identity.ts";
import type { ManifestMonitor } from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

const GRACE_FOR_TESTS_MS = 400;

function entry(overrides: Partial<ManifestMonitor> & Pick<ManifestMonitor, "monitorId">): ManifestMonitor {
	return {
		sessionId: "restore-session",
		description: "restore watch",
		runtimeKind: "command",
		durabilityClass: "restartable-command",
		command: "cat",
		createdAt: 1,
		expiresAt: null,
		persistent: true,
		suspended: true,
		lastCheckpoint: null,
		deliveryPaused: false,
		fireWindow: { startMs: 1, count: 0 },
		...overrides,
	};
}

describe.runIf(process.platform !== "win32")("restartable-command restore: grace, env, orphan, reasons", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	let tmp: string;
	let sessionDir: string;
	let workDir: string;
	let manager: TerminalManager;
	let registry: MonitorRegistry;
	let events: MonitorEvent[];
	let ctx: TerminalToolContext;

	beforeEach(async () => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = await mkdtemp(join(tmpdir(), "senpi-durable-restore-"));
		sessionDir = join(tmp, "session");
		workDir = join(tmp, "work");
		await mkdir(workDir, { recursive: true });
		manager = new TerminalManager();
		events = [];
		registry = new MonitorRegistry((event) => events.push(event));
		ctx = {
			manager,
			cwd: workDir,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
			getSessionContext: () =>
				({
					mode: "tui",
					sessionManager: { getSessionId: () => "restore-session", getSessionDir: () => sessionDir },
				}) as unknown as ExtensionContext,
		};
	});

	afterEach(async () => {
		registry.dispose();
		await manager.teardown();
		await rm(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	function handler(extra: Partial<Parameters<typeof createRestartableCommandHandler>[0]> = {}) {
		return createRestartableCommandHandler({ ctx, registry, graceMs: GRACE_FOR_TESTS_MS, ...extra });
	}

	function lines(): string[] {
		return events.flatMap((event) => (event.type === "line" ? [event.line] : []));
	}

	it("reports a watch whose script is gone as lost with its exit code, never restored", async () => {
		const result = await handler()(
			entry({ monitorId: "mon_GONESCRIPT00001", command: `sh ${join(tmp, "gone.sh")}`, cwd: workDir }),
			{ downtimeMs: 60_000 },
		);
		expect(result.outcome).toBe("lost");
		// The shell's own code for an unreadable script differs by OS (bash 127, dash 2): pin non-zero + the message.
		expect(result.reason).toMatch(/^exited [1-9]\d* in \d+ms: .*gone\.sh/);
	});

	it("restores a watch that is still running at the end of the grace window, with the restore env", async () => {
		const result = await handler()(
			entry({
				monitorId: "mon_LIVEWATCH000001",
				command:
					'printf "%s|%s|%s|%s\\n" "$SENPI_MONITOR_ID" "$SENPI_MONITOR_RESTORED" "$SENPI_MONITOR_DOWNTIME_MS" "$SENPI_MONITOR_STATE_DIR"; while true; do sleep 1; done',
				cwd: workDir,
			}),
			{ downtimeMs: 125_000 },
		);
		expect(result.outcome).toBe("restored");
		const envLine = lines().find((line) => line.startsWith("mon_LIVEWATCH000001|"));
		expect(envLine?.split("|")).toEqual([
			"mon_LIVEWATCH000001",
			"1",
			"125000",
			join(sessionDir, "extensions", "terminal", "state", "mon_LIVEWATCH000001"),
		]);
	});

	it("injects exactly one 'restored after' line for a restored watch", async () => {
		await handler()(
			entry({ monitorId: "mon_RESTOREDLINE01", command: "while true; do sleep 1; done", cwd: workDir }),
			{
				downtimeMs: 7_380_000,
			},
		);
		const restoredLines = lines().filter((line) => line.startsWith("restored after"));
		expect(restoredLines).toEqual(["restored after up to 2h 3m offline; the command started fresh"]);
	});

	it("reports a one-shot gate whose condition already holds as completed", async () => {
		const result = await handler()(entry({ monitorId: "mon_COMPLETEDGATE1", command: "true", cwd: workDir }), {
			downtimeMs: 0,
		});
		expect(result.outcome).toBe("completed");
	});

	it("stops a confirmed orphan before re-spawning and reports it", async () => {
		const reaped: ChildProcessIdentity[] = [];
		const orphan = { pid: 4_242_424, startedAtMs: 1, bootAtMs: 1, argv: ["sh", "-c", "cat"] };
		const result = await handler({
			reapOrphan: async (runtime) => {
				reaped.push(runtime);
				return { action: "killed" };
			},
		})(
			entry({
				monitorId: "mon_ORPHANKILLED01",
				command: "while true; do sleep 1; done",
				cwd: workDir,
				runtime: orphan,
			}),
			{
				downtimeMs: 0,
			},
		);
		expect(reaped).toEqual([orphan]);
		expect(result).toMatchObject({ outcome: "restored", orphan: { pid: 4_242_424, action: "killed" } });
	});

	it("leaves an unverifiable orphan alone and says so", async () => {
		const orphan = { pid: 4_242_425, startedAtMs: 1, bootAtMs: 1, argv: ["sh"] };
		const result = await handler({
			reapOrphan: async () => ({ action: "none", reason: "previous watcher pid 4242425 unverifiable" }),
		})(
			entry({
				monitorId: "mon_ORPHANUNVERIF1",
				command: "while true; do sleep 1; done",
				cwd: workDir,
				runtime: orphan,
			}),
			{
				downtimeMs: 0,
			},
		);
		expect(result).toMatchObject({ outcome: "restored", orphan: { pid: 4_242_425, action: "unverified" } });
	});

	it("re-spawns an ephemeral watch with only the time it had left", async () => {
		const requested: Array<number | undefined> = [];
		const result = await handler({
			spawn: async (spawnCtx, request) => {
				requested.push(request.timeoutMs);
				const { spawnCommandSession } = await import("../../src/core/extensions/builtin/terminal/tools/spawn.ts");
				return spawnCommandSession(spawnCtx, request);
			},
		})(
			entry({
				monitorId: "mon_EPHEMERALTIME1",
				durabilityClass: "ephemeral",
				persistent: false,
				command: "while true; do sleep 1; done",
				cwd: workDir,
				deadlineMs: Date.now() + 30_000,
			}),
			{ downtimeMs: 0, remainingMs: 30_000 },
		);
		expect(result.outcome).toBe("restored");
		expect(requested).toEqual([30_000]);
	});

	it("caps and sanitizes the output quoted in a lost reason", async () => {
		const result = await handler()(
			entry({
				monitorId: "mon_NOISYFAILURE01",
				command: `printf '\\033[31m%s\\033[0m\\n' "$(head -c 5000 /dev/zero | tr '\\0' x)"; exit 2`,
				cwd: workDir,
			}),
			{ downtimeMs: 0 },
		);
		expect(result.outcome).toBe("lost");
		expect(result.reason ?? "").not.toContain("\u001b");
		expect((result.reason ?? "").length).toBeLessThanOrEqual(260);
	});
});
