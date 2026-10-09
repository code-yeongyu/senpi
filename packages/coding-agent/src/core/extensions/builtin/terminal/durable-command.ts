/**
 * The `restartable-command` restore handler. It stops a verified crash-orphaned watcher first,
 * re-spawns the saved command once in the saved cwd with the restore environment (stable id,
 * state dir, restored flag, downtime bound), and only calls the watch restored if it is still
 * running when the grace window closes: an immediate non-zero exit is lost with its exit code and
 * first output line, an immediate zero exit is a completed one-shot gate. A persistent watch has
 * no deadline; an ephemeral one gets exactly the time it had left. Nothing the pre-restart PTY
 * produced is replayed.
 */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { MonitorRegistry } from "./monitor-registry.ts";
import { ensureMonitorStateDir, terminalStateDir } from "./monitor-state-dir.ts";
import { formatElapsedSeconds } from "./monitor-status.ts";
import { type ReapResult, reapBeforeRespawn } from "./orphan-reaper.ts";
import { sanitizeTerminalOutput } from "./output-format.ts";
import type { ChildProcessIdentity } from "./process-identity.ts";
import {
	type RestoreContext,
	type RestoreHandler,
	type RestoreHandlerResult,
	reapplyPersistedMute,
} from "./restore.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import {
	DEFAULT_COLS,
	DEFAULT_ROWS,
	MONITOR_ENV_DOWNTIME_MS,
	MONITOR_ENV_ID,
	MONITOR_ENV_RESTORED,
	MONITOR_ENV_STATE_DIR,
	RESTORE_GRACE_MS,
} from "./shared.ts";
import type { ManifestMonitor } from "./terminal-manifest.ts";
import type { TerminalToolContext } from "./tools/context.ts";
import { spawnCommandSession } from "./tools/spawn.ts";

export interface RestartableCommandDeps {
	readonly ctx: TerminalToolContext;
	readonly registry: MonitorRegistry;
	readonly spawn?: typeof spawnCommandSession;
	readonly directoryExists?: (path: string) => Promise<boolean>;
	readonly onRestored?: (monitorId: string, runtimeId: string) => void;
	readonly graceMs?: number;
	readonly reapOrphan?: (runtime: ChildProcessIdentity, monitorId: string) => Promise<ReapResult>;
}

const MAX_REASON_OUTPUT_CHARS = 200;

const lost = (reason: string, orphan?: RestoreHandlerResult["orphan"]): RestoreHandlerResult => ({
	outcome: "lost",
	reason,
	...(orphan !== undefined ? { orphan } : {}),
});

async function defaultDirectoryExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function compileFilter(source: string | undefined): RegExp | undefined {
	if (source === undefined) return undefined;
	try {
		return new RegExp(source);
	} catch {
		// A filter that no longer compiles must not sink the watch: restore it unfiltered.
		return undefined;
	}
}

function dimension(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback;
}

function exitsWithin(runtime: TerminalRuntimeSession, ms: number): Promise<boolean> {
	if (runtime.exited) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsubscribe();
			resolve(false);
		}, ms);
		const unsubscribe = runtime.session.onExit(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function firstOutputLine(runtime: TerminalRuntimeSession): string {
	const line = sanitizeTerminalOutput(runtime.fullOutput())
		.split("\n")
		.map((text) => text.trim())
		.find((text) => text.length > 0);
	return (line ?? "").slice(0, MAX_REASON_OUTPUT_CHARS);
}

function orphanOf(runtime: ChildProcessIdentity | undefined, reap: ReapResult | undefined) {
	if (runtime === undefined || reap === undefined) return undefined;
	if (reap.action === "killed") return { pid: runtime.pid, action: "killed" } as const;
	if (reap.reason !== undefined) return { pid: runtime.pid, action: "unverified" } as const;
	return undefined;
}

async function restoreEnvironment(
	deps: RestartableCommandDeps,
	monitor: ManifestMonitor,
	context: RestoreContext,
): Promise<Record<string, string>> {
	const env: Record<string, string> = {
		[MONITOR_ENV_ID]: monitor.monitorId,
		[MONITOR_ENV_RESTORED]: "1",
		[MONITOR_ENV_DOWNTIME_MS]: String(context.downtimeMs),
	};
	const terminalDir = terminalStateDir(deps.ctx.getSessionContext?.());
	if (monitor.persistent && terminalDir !== undefined) {
		env[MONITOR_ENV_STATE_DIR] = await ensureMonitorStateDir(terminalDir, monitor.monitorId);
	}
	return env;
}

export function createRestartableCommandHandler(deps: RestartableCommandDeps): RestoreHandler {
	const spawn = deps.spawn ?? spawnCommandSession;
	const directoryExists = deps.directoryExists ?? defaultDirectoryExists;
	const reapOrphan = deps.reapOrphan ?? reapBeforeRespawn;
	const graceMs = deps.graceMs ?? RESTORE_GRACE_MS;
	return async (monitor: ManifestMonitor, context: RestoreContext): Promise<RestoreHandlerResult> => {
		const ephemeralTimeLeft = monitor.persistent ? undefined : context.remainingMs;
		if (monitor.runtimeKind !== "command" || (!monitor.persistent && ephemeralTimeLeft === undefined)) {
			return lost("not a restorable command watch");
		}
		const { command, cwd } = monitor;
		if (command === undefined || command.length === 0) return lost("no command was recorded");
		if (cwd === undefined || !isAbsolute(cwd)) return lost("no absolute cwd was recorded");
		if (!(await directoryExists(cwd))) return lost(`cwd no longer exists: ${cwd}`);

		const reap = monitor.runtime === undefined ? undefined : await reapOrphan(monitor.runtime, monitor.monitorId);
		const orphan = orphanOf(monitor.runtime, reap);

		let spawned: Awaited<ReturnType<typeof spawnCommandSession>>;
		try {
			spawned = await spawn(deps.ctx, {
				command,
				cols: dimension(deps.ctx.defaultCols, DEFAULT_COLS),
				rows: dimension(deps.ctx.defaultRows, DEFAULT_ROWS),
				cwd,
				envOverrides: await restoreEnvironment(deps, monitor, context),
				...(ephemeralTimeLeft !== undefined ? { timeoutMs: ephemeralTimeLeft } : {}),
			});
		} catch (error) {
			return lost(`spawn failed: ${error instanceof Error ? error.message : String(error)}`, orphan);
		}

		deps.registry.register({
			id: spawned.id,
			monitorId: monitor.monitorId,
			description: monitor.description,
			command,
			persistent: monitor.persistent,
			deadlineMs: ephemeralTimeLeft !== undefined ? Date.now() + ephemeralTimeLeft : null,
			runtime: spawned.runtime,
			filter: compileFilter(monitor.filter),
			// The persisted deadline rides through verbatim; a restore never extends it.
			...(monitor.expiresAt !== null ? { expiresAt: monitor.expiresAt } : {}),
		});
		deps.ctx.manager.bindMonitorId(monitor.monitorId, spawned.id);

		const startedAt = Date.now();
		if (await exitsWithin(spawned.runtime, graceMs)) {
			const code = spawned.runtime.exitResult?.exitCode ?? null;
			if (code === 0) return { outcome: "completed", ...(orphan !== undefined ? { orphan } : {}) };
			const output = firstOutputLine(spawned.runtime);
			const exit = code === null ? "exited" : `exited ${code}`;
			return lost(`${exit} in ${Date.now() - startedAt}ms${output.length > 0 ? `: ${output}` : ""}`, orphan);
		}

		deps.registry.emitLine(
			spawned.id,
			`restored after up to ${formatElapsedSeconds(context.downtimeMs / 1000)} offline; the command started fresh`,
		);
		deps.onRestored?.(monitor.monitorId, spawned.id);
		// A persisted mute is re-applied by the FRESH runtime id; the registry resolves
		// records by runtime id only, so the mon_ id would silently no-op here.
		const outcome = reapplyPersistedMute(deps.registry, monitor, spawned.id);
		const runtime = spawned.runtime.identity();
		return { outcome, ...(orphan !== undefined ? { orphan } : {}), ...(runtime !== undefined ? { runtime } : {}) };
	};
}
