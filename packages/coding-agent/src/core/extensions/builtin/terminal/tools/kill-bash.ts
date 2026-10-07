import { type Static, Type } from "typebox";
import { removeMonitorStateDir, terminalStateDir } from "../monitor-state-dir.ts";
import { TERMINAL_KILL_TOOL } from "../shared.ts";
import {
	errorResult,
	resolveTerminalId,
	type TerminalToolContext,
	type TerminalToolResult,
	textResult,
} from "./context.ts";

export const killBashSchema = Type.Object({
	bash_id: Type.Optional(Type.String({ description: "Session id to tree-kill." })),
	all: Type.Optional(Type.Boolean({ description: "Tree-kill every live background session." })),
});

export type KillBashInput = Static<typeof killBashSchema>;

export function createKillBashTool(ctx: TerminalToolContext) {
	return {
		name: TERMINAL_KILL_TOOL,
		label: "kill_bash",
		description: "Terminate a background bash session (or all of them) and its process tree cleanly.",
		promptSnippet: "Tree-kill a background bash session (or all) with no orphans",
		parameters: killBashSchema,
		async execute(_toolCallId: string, input: KillBashInput, _signal?: AbortSignal): Promise<TerminalToolResult> {
			// An explicit kill ends a standing watch for good, so its restore state dir goes with it.
			// A process death does NOT come through here and keeps the dir for the next restore.
			const terminalDir = terminalStateDir(ctx.getSessionContext?.());
			const dropStateDir = async (monitorId: string | undefined): Promise<void> => {
				if (terminalDir !== undefined && monitorId !== undefined)
					await removeMonitorStateDir(terminalDir, monitorId);
			};
			if (input.all) {
				const terminalCount = ctx.manager.size;
				const monitorIds = (ctx.monitorRegistry?.snapshot() ?? []).map((entry) => entry.monitorId);
				const fileCount = (await ctx.monitorRegistry?.stopAllFiles()) ?? 0;
				await ctx.manager.teardown();
				for (const monitorId of monitorIds) await dropStateDir(monitorId);
				return textResult(`Killed ${terminalCount + fileCount} session(s).`);
			}
			if (!input.bash_id) return errorResult("Provide `bash_id` or set `all:true`.");
			const sessionId = resolveTerminalId(ctx.manager, input.bash_id);
			const monitorId = input.bash_id.startsWith("mon_") ? input.bash_id : ctx.manager.monitorIdOf?.(sessionId);
			if (await ctx.monitorRegistry?.stopFile(sessionId)) {
				await dropStateDir(monitorId);
				return textResult(`Killed ${input.bash_id}.`);
			}
			const runtime = ctx.manager.get(sessionId);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);
			await ctx.manager.stop(sessionId);
			await dropStateDir(monitorId);
			return textResult(`Killed ${input.bash_id}.`);
		},
	};
}
