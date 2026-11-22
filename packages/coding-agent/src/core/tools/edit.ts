import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createLocalSyntaxChecker } from "./bun-script-parser.ts";
import {
	type CoreEditToolOptions,
	createCoreEditToolDefinition,
	type EditToolDetails,
	type editSchema,
} from "./edit-core.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { canonicalizeFilesystemPath } from "./filesystem-policy.ts";
import { defaultToolMachine } from "./machine.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export {
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	editToolSystemPromptContribution,
} from "./edit-core.ts";

export interface EditToolOptions extends Pick<CoreEditToolOptions, "operations" | "filesystemPolicy"> {
	/** Operation layer and policy gate. Default: the process-wide local machine. */
	machine?: CoreEditToolOptions["machine"];
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	return {
		...(options?.operations !== undefined || options?.filesystemPolicy !== undefined ? { serverPinned: true } : {}),
		...createCoreEditToolDefinition(cwd, {
			...options,
			machine: options?.machine ?? defaultToolMachine(),
			resolvePath: resolveToCwd,
			withMutationQueue: withFileMutationQueue,
			canonicalizePath: canonicalizeFilesystemPath,
			checkSyntax: createLocalSyntaxChecker(),
		}),
		...editRenderers,
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
