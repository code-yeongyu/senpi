import { type Static, Type } from "typebox";
import { TERMINAL_KILL_TOOL } from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";

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
			if (input.all) {
				const count = ctx.manager.size;
				await ctx.manager.teardown();
				return textResult(`Killed ${count} terminal session(s).`);
			}
			if (!input.bash_id) return errorResult("Provide `bash_id` or set `all:true`.");
			const runtime = ctx.manager.get(input.bash_id);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);
			await ctx.manager.stop(input.bash_id);
			return textResult(`Killed ${input.bash_id}.`);
		},
	};
}
