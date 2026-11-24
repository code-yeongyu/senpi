import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createLocalSyntaxChecker } from "./bun-syntax-check.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { canonicalizeFilesystemPath } from "./filesystem-policy.ts";
import { defaultToolMachine } from "./machine.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { type CoreWriteToolOptions, createCoreWriteToolDefinition, type writeSchema } from "./write-core.ts";
import type { WriteBaseline, WriteToolDetails } from "./write-result.ts";

export { type WriteOperations, type WriteToolInput, writeToolSystemPromptContribution } from "./write-core.ts";

export interface WriteToolOptions extends Pick<CoreWriteToolOptions, "operations" | "filesystemPolicy"> {
	/** Operation layer and policy gate. Default: the process-wide local machine. */
	machine?: CoreWriteToolOptions["machine"];
}

async function readLocalWriteBaseline(absolutePath: string): Promise<WriteBaseline> {
	try {
		return { kind: "present", content: await readFile(absolutePath, "utf-8") };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
		if (error instanceof Error) return { kind: "unavailable" };
		throw error;
	}
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
	return {
		...(options?.operations !== undefined || options?.filesystemPolicy !== undefined ? { serverPinned: true } : {}),
		...createCoreWriteToolDefinition(cwd, {
			...options,
			machine: options?.machine ?? defaultToolMachine(),
			resolvePath: resolveToCwd,
			dirname,
			withMutationQueue: withFileMutationQueue,
			canonicalizePath: canonicalizeFilesystemPath,
			readBaseline: readLocalWriteBaseline,
			checkSyntax: createLocalSyntaxChecker(),
		}),
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
