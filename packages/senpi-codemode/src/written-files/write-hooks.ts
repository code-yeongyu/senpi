import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import { capCodePoints } from "../tool/call-capture.ts";
import type { ScanFs } from "./workspace-fs.ts";
import { isSourceText, SOURCE_FILE_MAX_BYTES, SOURCE_FILE_SNIFF_BYTES } from "./source-file.ts";
import type { ChangedFile } from "./tracker.ts";

/** Files listed in a cell result and sent through the write hooks; the rest are counted. */
export const WRITTEN_FILES_LIMIT = 20;

const HOOK_OUTPUT_FILE_CODE_POINTS = 2_000;
const HOOK_OUTPUT_CELL_CODE_POINTS = 12_000;
const HOOK_ERROR_CODE_POINTS = 300;
const SNIFF_BATCH = 32;

export type ReportToolResult = ExtensionToolContext["reportToolResult"];
type HookContent = NonNullable<Awaited<ReturnType<ReportToolResult>>["result"]>["content"];

export interface WrittenFilesReport {
	/** Workspace-relative paths of the first {@link WRITTEN_FILES_LIMIT} source files written. */
	readonly files: readonly string[];
	readonly total: number;
	/** How many of `files` the write hooks ran for. */
	readonly hooked: number;
	readonly hookOutputs: readonly { readonly path: string; readonly text: string }[];
	readonly hookFailures: readonly { readonly path: string; readonly error: string }[];
}

export interface WriteHookDeps {
	readonly fs: Pick<ScanFs, "read">;
	/** Absent on a host that cannot run `tool_result` handlers for work already done. */
	readonly report: ReportToolResult | undefined;
	readonly noteHooked: (absolutePath: string) => Promise<void>;
	readonly signal: AbortSignal;
}

/**
 * Sends the content each written file has on disk through the `tool_result` handlers a `write` call triggers. Nothing
 * is written again, so a hook sees exactly what the cell left and no change made meanwhile can be overwritten.
 */
export async function reportWrittenFiles(
	changed: readonly ChangedFile[],
	deps: WriteHookDeps,
): Promise<WrittenFilesReport | undefined> {
	const sources = await sourceFiles(changed, deps.fs);
	if (sources.length === 0) return undefined;
	const listed = sources.slice(0, WRITTEN_FILES_LIMIT);
	const hookOutputs: { path: string; text: string }[] = [];
	const hookFailures: { path: string; error: string }[] = [];
	const fail = (path: string, error: string) =>
		hookFailures.push({ path, error: capCodePoints(error, HOOK_ERROR_CODE_POINTS) });
	let outputBudget = HOOK_OUTPUT_CELL_CODE_POINTS;
	let hooked = 0;
	for (const file of listed) {
		const report = deps.report;
		if (report === undefined || deps.signal.aborted) break;
		const bytes = await deps.fs.read(file.absolutePath, SOURCE_FILE_MAX_BYTES + 1);
		if (bytes === undefined || bytes.length > SOURCE_FILE_MAX_BYTES) {
			fail(file.path, "the file could not be read back for the hooks");
			continue;
		}
		const written = `Successfully wrote to ${file.absolutePath}`;
		try {
			const outcome = await report({
				toolName: "write",
				input: { path: file.absolutePath, content: new TextDecoder().decode(bytes) },
				content: [{ type: "text", text: written }],
			});
			hooked += 1;
			for (const failure of outcome.failures) fail(file.path, `${failure.extensionPath}: ${failure.error}`);
			const text = appendedText(outcome.result?.content, written);
			if (text !== "") {
				const shown =
					outputBudget > 0
						? capCodePoints(text, Math.min(HOOK_OUTPUT_FILE_CODE_POINTS, outputBudget))
						: "[hook output omitted: this cell's hook output limit was reached]";
				outputBudget -= shown.length;
				hookOutputs.push({ path: file.path, text: shown });
			}
		} catch (error) {
			fail(file.path, error instanceof Error ? error.message : String(error));
			continue;
		}
		// A hook may rewrite the file (a formatter); that rewrite is not a later cell's write.
		await deps.noteHooked(file.absolutePath);
	}
	return { files: listed.map((file) => file.path), total: sources.length, hooked, hookOutputs, hookFailures };
}

async function sourceFiles(changed: readonly ChangedFile[], fs: Pick<ScanFs, "read">): Promise<ChangedFile[]> {
	const sources: ChangedFile[] = [];
	for (let start = 0; start < changed.length; start += SNIFF_BATCH) {
		const batch = changed.slice(start, start + SNIFF_BATCH);
		const heads = await Promise.all(batch.map((file) => fs.read(file.absolutePath, SOURCE_FILE_SNIFF_BYTES)));
		batch.forEach((file, index) => {
			const head = heads[index];
			if (head !== undefined && isSourceText(head)) sources.push(file);
		});
	}
	return sources;
}

/** What the handlers added to the result: its text without the line this module supplied itself. */
function appendedText(content: HookContent, written: string): string {
	if (content === undefined) return "";
	const texts = content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	if (texts[0] === written) texts.shift();
	return texts.join("\n").trim();
}
