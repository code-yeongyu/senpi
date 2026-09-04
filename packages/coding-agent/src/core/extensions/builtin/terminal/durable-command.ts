/**
 * The `restartable-command` durability class: the restore handler that brings a persistent
 * command monitor back after a restart. It re-spawns the saved command EXACTLY ONCE, in the
 * saved working directory, with NO timeout (a persistent watch has no deadline), and
 * re-registers it under the SAVED `mon_` id so the stable handle the agent already knows
 * keeps resolving. Nothing the pre-restart PTY produced is replayed — no output is persisted
 * anywhere, so a restored watch starts from an empty buffer by construction.
 */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { MonitorRegistry } from "./monitor-registry.ts";
import { type RestoreHandler, type RestoreHandlerResult, reapplyPersistedMute } from "./restore.ts";
import { DEFAULT_COLS, DEFAULT_ROWS } from "./shared.ts";
import type { ManifestMonitor } from "./terminal-manifest.ts";
import type { TerminalToolContext } from "./tools/context.ts";
import { spawnCommandSession } from "./tools/spawn.ts";

export interface RestartableCommandDeps {
	/** Spawn target: supplies the terminal manager, shell config, env and default geometry. */
	readonly ctx: TerminalToolContext;
	/** The live registry this generation owns; the restored watch is registered here. */
	readonly registry: MonitorRegistry;
	/** Seam for tests and future callers; defaults to the real PTY spawn. */
	readonly spawn?: typeof spawnCommandSession;
	/** Directory existence probe; defaults to a real stat of the saved cwd. */
	readonly directoryExists?: (path: string) => Promise<boolean>;
	/** Called after a successful restore with the stable id and its fresh runtime id. */
	readonly onRestored?: (monitorId: string, runtimeId: string) => void;
}

const LOST: RestoreHandlerResult = { outcome: "lost" };

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

/**
 * Decide whether a manifest entry is a restorable persistent command watch. Only the
 * command runtime kind qualifies, only when it was created `persistent: true` (a
 * non-persistent watch had a deadline and is deliberately not resurrected), and only
 * when it actually carries a command and an absolute cwd to spawn it in.
 */
function restorable(monitor: ManifestMonitor): { command: string; cwd: string } | undefined {
	if (monitor.runtimeKind !== "command" || !monitor.persistent) return undefined;
	const { command, cwd } = monitor;
	if (command === undefined || command.length === 0) return undefined;
	if (cwd === undefined || !isAbsolute(cwd)) return undefined;
	return { command, cwd };
}

/**
 * Build the `restartable-command` restore handler. Every guard rejects BEFORE spawning, so a
 * rejected entry costs zero PTY sessions; a spawn failure is reported lost rather than thrown,
 * because restore must never fail the startup path for one unrecoverable watch.
 */
export function createRestartableCommandHandler(deps: RestartableCommandDeps): RestoreHandler {
	const spawn = deps.spawn ?? spawnCommandSession;
	const directoryExists = deps.directoryExists ?? defaultDirectoryExists;
	return async (monitor: ManifestMonitor): Promise<RestoreHandlerResult> => {
		const target = restorable(monitor);
		if (target === undefined) return LOST;
		if (!(await directoryExists(target.cwd))) return LOST;

		let spawned: Awaited<ReturnType<typeof spawnCommandSession>>;
		try {
			spawned = await spawn(deps.ctx, {
				command: target.command,
				cols: dimension(deps.ctx.defaultCols, DEFAULT_COLS),
				rows: dimension(deps.ctx.defaultRows, DEFAULT_ROWS),
				cwd: target.cwd,
				// Persistent watches carry no deadline: omit timeoutMs entirely.
			});
		} catch {
			return LOST;
		}

		deps.registry.register({
			id: spawned.id,
			monitorId: monitor.monitorId,
			description: monitor.description,
			runtime: spawned.runtime,
			filter: compileFilter(monitor.filter),
		});
		deps.ctx.manager.bindMonitorId(monitor.monitorId, spawned.id);
		deps.onRestored?.(monitor.monitorId, spawned.id);
		// A persisted mute is re-applied by the FRESH runtime id; the registry resolves
		// records by runtime id only, so the mon_ id would silently no-op here.
		return { outcome: reapplyPersistedMute(deps.registry, monitor, spawned.id) };
	};
}
