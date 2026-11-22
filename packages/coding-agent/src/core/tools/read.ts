import { type AgentTool, selectedReadFolder } from "@earendil-works/pi-agent-core";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { canonicalizeFilesystemPath } from "./filesystem-policy.ts";
import { defaultToolMachine } from "./machine.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import {
	type CoreReadToolOptions,
	createCoreReadToolDefinition,
	type ReadToolDetails,
	type readSchema,
} from "./read-core.ts";
import { type ReadRenderState, readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export {
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	readToolSystemPromptContribution,
} from "./read-core.ts";

export interface ReadToolOptions extends Pick<
	CoreReadToolOptions,
	"folder" | "autoResizeImages" | "resizeOptions" | "contextModel" | "operations" | "filesystemPolicy"
> {
	/** Operation layer and policy gate. Default: the process-wide local machine. */
	machine?: CoreReadToolOptions["machine"];
}

export function createReadToolDefinition(
	cwd: string,
	options: ReadToolOptions = { folder: selectedReadFolder },
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined, ReadRenderState> {
	return {
		...(options.operations !== undefined || options.filesystemPolicy !== undefined ? { serverPinned: true } : {}),
		...createCoreReadToolDefinition(cwd, {
			...options,
			machine: options.machine ?? defaultToolMachine(),
			resolveReadPath: resolveReadPathAsync,
			canonicalizePath: canonicalizeFilesystemPath,
			detectImageMimeType: detectSupportedImageMimeTypeFromFile,
			processImage,
		}),
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
