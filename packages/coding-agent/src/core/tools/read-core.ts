import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ReadFolder, selectedReadFolder } from "@earendil-works/pi-agent-core/read-folders";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../../utils/image-mime.ts";
import type { ProcessImageOptions, ProcessImageResult } from "../../utils/image-process.ts";
import type { ExtensionContext, FilesystemPolicyChecker, ToolDefinition } from "../extensions/types.ts";
import { decodeUtf8, encodeBase64 } from "./encoding.ts";
import {
	lexicalCanonicalPath,
	resolvePosixToolPath,
	resolveReadPathVariants,
	type ToolPathCanonicalizer,
} from "./file-tool-host.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import type { ToolMachine } from "./tool-machine.ts";
import { type ReadToolDetails, shapeTextRead } from "./read-text.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Files: read, not cat/sed."],
	fullGuidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export type { ReadToolDetails } from "./read-text.ts";

const LOCAL_URI_SCHEME = /^local:\/\//i;
const LOCAL_URI_GUIDANCE =
	"local:// URIs resolve only inside eval cells via the kernel read()/write() helpers; the read tool takes filesystem paths. Re-read this with the eval read() helper, or retry with the plain absolute file path.";

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents */
	readFile: (absolutePath: string) => Promise<Uint8Array>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

/** Turns an image file's bytes into the inline image the model receives, or a note why it cannot. */
export type ReadImageProcessor = (
	bytes: Uint8Array,
	mimeType: string,
	options: ProcessImageOptions,
) => Promise<ProcessImageResult>;

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const inlineImageAsIs: ReadImageProcessor = async (bytes, mimeType) =>
	INLINE_IMAGE_TYPES.has(mimeType)
		? { ok: true, data: encodeBase64(bytes), mimeType, hints: [] }
		: { ok: false, message: "[Image omitted: could not be converted to a supported inline image format.]" };

export interface CoreReadToolOptions {
	/** Operation layer and policy gate. */
	machine: ToolMachine;
	/** Structural folder. Default options select the measured folder; omit here for verbatim reads. */
	folder?: ReadFolder;
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Read the model from the execution context. False for a runtime without a session, whose context refuses `model` (senpi#5223). Default: true */
	contextModel?: boolean;
	/** Custom operations for file reading. Default: reads through `machine` */
	operations?: ReadOperations;
	/** Extension-registered filesystem policy checker. */
	filesystemPolicy?: FilesystemPolicyChecker;
	/** Resolves the model's path, trying spelling variants. Default: POSIX resolution, variants probed on `machine`. */
	resolveReadPath?: (path: string, cwd: string) => Promise<string>;
	/** The path `filesystemPolicy` judges. Default: the resolved path as is. */
	canonicalizePath?: ToolPathCanonicalizer;
	/** Image detection for the default operations. Default: the file's leading bytes read on `machine`. */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/** Default: inline PNG, JPEG, GIF and WebP as they are; other formats are omitted with a note. */
	processImage?: ReadImageProcessor;
}

function machineReadPath(machine: ToolMachine): (path: string, cwd: string) => Promise<string> {
	const exists = (path: string) =>
		machine.ops.files.stat({ path }, machine.context(undefined)).then(
			() => true,
			() => false,
		);
	return (path, cwd) => resolveReadPathVariants(path, cwd, resolvePosixToolPath, exists);
}

/** The default read operations: the shared operation layer, called with the context of one admitted call. */
function machineReadOperations(
	machine: ToolMachine,
	signal: AbortSignal | undefined,
	detectImageMimeType: ReadOperations["detectImageMimeType"],
): ReadOperations {
	const ctx = machine.context(signal);
	return {
		readFile: async (path) => (await machine.ops.files.read({ path }, ctx)).bytes,
		access: async (path) => {
			await machine.ops.files.stat({ path, access: "read" }, ctx);
		},
		detectImageMimeType:
			detectImageMimeType ??
			(async (path) => {
				const head = await machine.ops.files.read({ path, offset: 0, limitBytes: IMAGE_TYPE_SNIFF_BYTES }, ctx);
				return detectSupportedImageMimeType(head.bytes);
			}),
	};
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createCoreReadToolDefinition(
	cwd: string,
	options: CoreReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options.autoResizeImages ?? true;
	const fallbackResizeOptions = options.resizeOptions;
	const contextModel = options.contextModel ?? true;
	const customOps = options.operations;
	const machine = options.machine;
	const filesystemPolicy = options.filesystemPolicy;
	const resolveReadPath = options.resolveReadPath ?? machineReadPath(machine);
	const canonicalizePath = options.canonicalizePath ?? lexicalCanonicalPath;
	const processImage = options.processImage ?? inlineImageAsIs;
	return {
		name: "read",
		workspaceEffect: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. A .js or .json file of 100+ lines read without offset/limit may come back folded: bodies are replaced by markers and a footer lists the offset/limit ranges to reread; markers are not source, so reread those ranges before quoting or editing them.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		fullPromptGuidelines: [...readToolSystemPromptContribution.fullGuidelines],
		parameters: readSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			if (LOCAL_URI_SCHEME.test(path)) {
				throw new Error(LOCAL_URI_GUIDANCE);
			}
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const admitted = machine.begin("files.read", { path, offset, limit }, signal);
							if (admitted !== undefined) await admitted;
							if (aborted) return;
							const ops = customOps ?? machineReadOperations(machine, signal, options.detectImageMimeType);
							const absolutePath = await resolveReadPath(path, ctx?.cwd || cwd);
							if (aborted) return;
							if (filesystemPolicy) {
								const decision = await filesystemPolicy({
									operation: "read",
									canonicalPath: await canonicalizePath(absolutePath),
									toolName: "read",
								});
								if (!decision.allow) throw new Error(decision.reason);
								if (aborted) return;
							}
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const model = contextModel ? ctx?.model : undefined;
							const nonVisionImageNote = getNonVisionImageNote(model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, {
									autoResizeImages,
									resizeOptions: model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
								});
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content.
								const buffer = await ops.readFile(absolutePath);
								if (aborted) return;
								const shaped = await shapeTextRead({
									path,
									absolutePath,
									textContent: decodeUtf8(buffer),
									offset,
									limit,
									folder: options.folder,
									isAborted: () => aborted,
								});
								if (shaped === undefined) return;
								content = shaped.content;
								details = shaped.details;
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: unknown) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
	};
}

/** The read tool for a host whose only effect channel is `machine`; reads fold like the local tool's by default. */
export function createCoreReadTool(cwd: string, options: CoreReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createCoreReadToolDefinition(cwd, { folder: selectedReadFolder, ...options }));
}

export { readSchema };
