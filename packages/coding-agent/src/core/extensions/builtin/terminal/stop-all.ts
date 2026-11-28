import type { SessionStopItem } from "../../types.ts";
import { removeMonitorStateDir, terminalStateDir } from "./monitor-state-dir.ts";
import type { TerminalToolContext } from "./tools/context.ts";

/** What a kill of every terminal session ended: the monitors and the plain background shells, each named. */
export interface StoppedTerminalWork {
	readonly monitors: readonly SessionStopItem[];
	readonly shells: readonly SessionStopItem[];
	/** Sessions and watches the kill ended, counted as `kill_bash { all: true }` always reported them. */
	readonly killed: number;
}

/**
 * Tree-kill every live terminal session and every monitor (command, file and rpc watches), and drop each monitor's
 * restore state dir: an explicit kill ends a standing watch for good. Shared by `kill_bash { all: true }` and the
 * session stop (oh-my-openagent#14390), which also empties the restore manifest.
 */
export async function stopAllTerminalWork(ctx: TerminalToolContext): Promise<StoppedTerminalWork> {
	const watches = ctx.monitorRegistry?.snapshot() ?? [];
	const watchIds = new Set(watches.map((entry) => entry.id));
	const monitors = watches.map((entry): SessionStopItem => ({
		kind: "monitor",
		id: entry.monitorId ?? entry.id,
		label: entry.description,
	}));
	const shells = ctx.manager
		.list()
		.filter(({ id }) => !watchIds.has(id) && ctx.manager.monitorIdOf?.(id) === undefined)
		.map(({ id, runtime }): SessionStopItem => ({ kind: "background_shell", id, label: runtime.command }));
	const terminalCount = ctx.manager.size;
	const fileCount = (await ctx.monitorRegistry?.stopAllFiles()) ?? 0;
	const rpcCount = ctx.monitorRegistry?.stopAllRpc() ?? 0;
	await ctx.manager.teardown();
	const terminalDir = terminalStateDir(ctx.getSessionContext?.());
	if (terminalDir !== undefined)
		for (const watch of watches)
			if (watch.monitorId !== undefined) await removeMonitorStateDir(terminalDir, watch.monitorId);
	return { monitors, shells, killed: terminalCount + fileCount + rpcCount };
}
