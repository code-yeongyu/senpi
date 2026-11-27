import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, FilesystemPolicyChecker, ToolDefinition } from "../extensions/types.ts";
import { decodeUtf8, encodeUtf8 } from "./encoding.ts";
import { fsErrorCode } from "./fs-error-code.ts";
import {
	type FileMutationQueue,
	inProcessFileMutationQueue,
	lexicalCanonicalPath,
	posixDirname,
	refuseSpecialFile,
	resolvePosixToolPath,
	type ToolPathCanonicalizer,
	type ToolPathResolver,
} from "./file-tool-host.ts";
import { createSyntaxChecker, parseBreakWarning, type SyntaxChecker } from "./syntax-check.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import type { ToolMachine } from "./tool-machine.ts";
import { createWriteDetails, type WriteBaseline, type WriteToolDetails } from "./write-result.ts";

export const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["write only for new files or full rewrites."],
	fullGuidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

/**
 * The default write operations over the shared operation layer. `files.write` creates the parent directory in the
 * same call (`createParentDirs`), so `mkdir` has nothing left to do; the tool already holds the file's mutation slot.
 */
function machineWriteOperations(machine: ToolMachine, signal: AbortSignal | undefined): WriteOperations {
	const ctx = machine.context(signal, "caller");
	return {
		writeFile: async (path, content) => {
			await machine.ops.files.write({ path, bytes: encodeUtf8(content), createParentDirs: true }, ctx);
		},
		mkdir: async () => {},
	};
}

/** The file's content before the write, read on the machine; it feeds the patch in the result details. */
function machineWriteBaseline(machine: ToolMachine): (absolutePath: string) => Promise<WriteBaseline> {
	return async (absolutePath) => {
		try {
			const { bytes } = await machine.ops.files.read({ path: absolutePath }, machine.context(undefined, "caller"));
			return { kind: "present", content: decodeUtf8(bytes) };
		} catch (error) {
			if (error instanceof Error && fsErrorCode(error) === "ENOENT") return { kind: "missing" };
			if (error instanceof Error) return { kind: "unavailable" };
			throw error;
		}
	};
}

export interface CoreWriteToolOptions {
	/** Operation layer and policy gate. */
	machine: ToolMachine;
	/** Custom operations for file writing. Default: writes through `machine` */
	operations?: WriteOperations;
	/** Extension-registered filesystem policy checker. */
	filesystemPolicy?: FilesystemPolicyChecker;
	/** Default: POSIX resolution against the cwd. */
	resolvePath?: ToolPathResolver;
	/** The directory handed to `operations.mkdir`. Default: POSIX dirname. */
	dirname?: (absolutePath: string) => string;
	/** Default: one queue per path string in this isolate, shared with the core edit tool. */
	withMutationQueue?: FileMutationQueue;
	/** The path `filesystemPolicy` judges. Default: the resolved path as is. */
	canonicalizePath?: ToolPathCanonicalizer;
	/** The content before the write, for the result's patch. Default: read on `machine`; none with custom operations. */
	readBaseline?: (absolutePath: string) => Promise<WriteBaseline>;
	/** Parse check behind the parse-break warning. Default: JSON only. */
	checkSyntax?: SyntaxChecker;
}

function writeParseBreakWarning(
	checkSyntax: SyntaxChecker,
	path: string,
	baseline: WriteBaseline,
	content: string,
): string | undefined {
	switch (baseline.kind) {
		case "missing":
			return parseBreakWarning(checkSyntax, path, undefined, content);
		case "present":
			return parseBreakWarning(checkSyntax, path, baseline.content, content);
		case "unavailable":
			return undefined;
		default: {
			const exhaustive: never = baseline;
			return exhaustive;
		}
	}
}

export function createCoreWriteToolDefinition(
	cwd: string,
	options: CoreWriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
	const machine = options.machine;
	const readBaseline = options.operations ? undefined : (options.readBaseline ?? machineWriteBaseline(machine));
	const filesystemPolicy = options.filesystemPolicy;
	const resolvePath = options.resolvePath ?? resolvePosixToolPath;
	const dirname = options.dirname ?? posixDirname;
	const withMutationQueue = options.withMutationQueue ?? inProcessFileMutationQueue;
	const canonicalizePath = options.canonicalizePath ?? lexicalCanonicalPath;
	const checkSyntax = options.checkSyntax ?? createSyntaxChecker();
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		fullPromptGuidelines: [...writeToolSystemPromptContribution.fullGuidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const admitted = machine.begin("files.write", { path, content }, signal);
			if (admitted !== undefined) await admitted;
			const ops = options.operations ?? machineWriteOperations(machine, signal);
			const absolutePath = resolvePath(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			return withMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				if (filesystemPolicy) {
					const decision = await filesystemPolicy({
						operation: "write",
						canonicalPath: await canonicalizePath(absolutePath),
						toolName: "write",
					});
					if (!decision.allow) throw new Error(decision.reason);
					throwIfAborted();
				}
				// Before the baseline read: custom operations own their filesystem; the machine's would block on a FIFO.
				if (!options.operations) {
					await refuseSpecialFile(machine, machine.context(signal, "caller"), absolutePath, path, "write");
					throwIfAborted();
				}
				const baseline = readBaseline ? await readBaseline(absolutePath) : ({ kind: "unavailable" } as const);
				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				const warning = writeParseBreakWarning(checkSyntax, path, baseline, content);
				const summary = `Successfully wrote to ${path}`;
				return {
					content: [{ type: "text", text: warning === undefined ? summary : `${summary}\n\n${warning}` }],
					details: createWriteDetails(path, content, baseline),
				};
			});
		},
	};
}

export function createCoreWriteTool(cwd: string, options: CoreWriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createCoreWriteToolDefinition(cwd, options));
}
