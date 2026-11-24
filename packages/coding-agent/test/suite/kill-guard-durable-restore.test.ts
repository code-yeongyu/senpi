// senpi#5349 (A5): a restored durable monitor command is judged again before it respawns, because the manifest
// carries no guard state and a monitor created before the guard (or while it was off) was never judged.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRestartableCommandHandler } from "../../src/core/extensions/builtin/terminal/durable-command.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { ManifestMonitor } from "../../src/core/extensions/builtin/terminal/terminal-manifest.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { spawnCommandSession } from "../../src/core/extensions/builtin/terminal/tools/spawn.ts";

function entry(monitorId: string, command: string, cwd: string): ManifestMonitor {
	return {
		sessionId: "kill-guard-restore",
		monitorId,
		description: "restore watch",
		runtimeKind: "command",
		durabilityClass: "restartable-command",
		command,
		cwd,
		createdAt: 1,
		expiresAt: null,
		persistent: true,
		suspended: true,
		lastCheckpoint: null,
		deliveryPaused: false,
		fireWindow: { startMs: 1, count: 0 },
	};
}

describe.runIf(process.platform !== "win32")("durable monitor restore re-judges its command", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	let tmp: string;
	let manager: TerminalManager;
	let registry: MonitorRegistry;
	let ctx: TerminalToolContext;
	let spawned: string[];

	beforeEach(async () => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = await mkdtemp(join(tmpdir(), "senpi-kill-guard-restore-"));
		await mkdir(join(tmp, "work"), { recursive: true });
		manager = new TerminalManager();
		registry = new MonitorRegistry(() => {});
		spawned = [];
		ctx = {
			manager,
			cwd: join(tmp, "work"),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
		};
	});

	afterEach(async () => {
		registry.dispose();
		await manager.teardown();
		await rm(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	const handler = () =>
		createRestartableCommandHandler({
			ctx,
			registry,
			graceMs: 200,
			spawn: async (context, request) => {
				spawned.push(request.command);
				// Never really run a kill-family command, even when the guard is missing (the RED run on the base).
				if (/kill/.test(request.command)) throw new Error("test spawn refused a kill command");
				return spawnCommandSession(context, request);
			},
		});

	it("reports a refused command as a restore failure with zero spawns", async () => {
		const result = await handler()(entry("mon_KILLGUARD00001", "pkill -f '.*'", join(tmp, "work")), {
			downtimeMs: 1_000,
		});

		expect(result.outcome).toBe("lost");
		expect(result.reason).toContain("[senpi:kill-guard]");
		expect(spawned).toEqual([]);
	});

	it("restores and spawns a narrow command once", async () => {
		const result = await handler()(entry("mon_KILLGUARD00002", "cat", join(tmp, "work")), { downtimeMs: 1_000 });

		expect(result.outcome).toBe("restored");
		expect(spawned).toEqual(["cat"]);
	});
});
