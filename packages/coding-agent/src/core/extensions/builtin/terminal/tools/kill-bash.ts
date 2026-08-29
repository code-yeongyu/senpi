import { type Static, Type } from "typebox";
import { TERMINAL_KILL_TOOL } from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";

export const killBashSchema = Type.Object({
	bash_id: Type.Optional(Type.String({ description: "Terminal or native monitor id to terminate." })),
	all: Type.Optional(Type.Boolean({ description: "Terminate every live terminal session and native monitor." })),
});

export type KillBashInput = Static<typeof killBashSchema>;

export function createKillBashTool(ctx: TerminalToolContext) {
	return {
		name: TERMINAL_KILL_TOOL,
		label: "kill_bash",
		description: "Terminate a terminal session or native file monitor and release its resources.",
		promptSnippet: "Terminate a terminal session or native monitor with no orphans",
		parameters: killBashSchema,
		async execute(_toolCallId: string, input: KillBashInput, _signal?: AbortSignal): Promise<TerminalToolResult> {
			if (input.all) {
				const terminalCount = ctx.manager.size;
				let fileCount = 0;
				const errors: Error[] = [];
				try {
					fileCount = (await ctx.monitorRegistry?.stopAllFiles()) ?? 0;
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					errors.push(error);
				}
				try {
					await ctx.manager.teardown();
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					errors.push(error);
				}
				if (errors.length > 0) throw new AggregateError(errors, "Failed to stop every terminal session.");
				if (fileCount === 0) return textResult(`Killed ${terminalCount} terminal session(s).`);
				return textResult(`Killed ${terminalCount + fileCount} session(s).`);
			}
			if (!input.bash_id) return errorResult("Provide `bash_id` or set `all:true`.");
			if (await ctx.monitorRegistry?.stopFile(input.bash_id)) return textResult(`Killed ${input.bash_id}.`);
			const runtime = ctx.manager.get(input.bash_id);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);
			await ctx.manager.stop(input.bash_id);
			return textResult(`Killed ${input.bash_id}.`);
		},
	};
}
