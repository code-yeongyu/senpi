import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import { appendPostMutateNote, runPostMutate } from "./post-mutate.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export function createWriteTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof writeSchema,
	undefined
> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path, content }, signal, _onUpdate, { env, postMutate }) {
			const absolutePath = await resolveToolPath(env, path, signal);
			return withFileMutationQueue(env, absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				getOrThrow(await env.writeFile(absolutePath, content, signal));
				if (signal?.aborted) throw new Error("Operation aborted");
				const outcome = await runPostMutate(postMutate, { tool: "write", path: absolutePath, signal });
				if (signal?.aborted) throw new Error("Operation aborted");
				const text = appendPostMutateNote(`Successfully wrote ${content.length} bytes to ${path}`, outcome.note);
				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			});
		},
	};
}
