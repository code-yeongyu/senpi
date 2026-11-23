import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import { capCodePoints } from "../tool/call-capture.ts";
import type { ScanFs } from "./workspace-fs.ts";
import { isSourceText, SOURCE_FILE_MAX_BYTES, SOURCE_FILE_SNIFF_BYTES } from "./source-file.ts";
import {
	type ChangedFile,
	type ClaimRelease,
	type HookStart,
	withoutCeded,
	type WrittenFilesSelection,
} from "./window.ts";

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
	/** The hooks for this file returned or failed: what they left on disk is the reporting cell's. */
	readonly noteHooked: (absolutePath: string) => Promise<void>;
	/**
	 * The hooks for this listed file start now if this says `started`; `refused` when the cell may no longer start them
	 * (it closed), `ceded` when a model call took the file and the cell let go of it.
	 */
	readonly start: (absolutePath: string) => HookStart;
	/** The hooks for this listed file will not start: the cell lets go of it, and its change stays for a later cell. */
	readonly skipped: (absolutePath: string) => ClaimRelease;
	/** This listed file could not be read back: the cell lets go of it, and reports that unless a model call took it. */
	readonly failed: (absolutePath: string) => ClaimRelease;
	readonly signal: AbortSignal;
}

/** The changed files a cell lists and, when `hooks` is set, sends through the write hooks: its first source files. */
export async function selectWrittenFiles(
	changed: readonly ChangedFile[],
	fs: Pick<ScanFs, "read">,
	hooks: boolean,
): Promise<WrittenFilesSelection> {
	const sources = await sourceFiles(changed, fs);
	return { listed: sources.slice(0, WRITTEN_FILES_LIMIT), total: sources.length, hooks };
}

/**
 * Sends the content each listed file has on disk through the `tool_result` handlers a `write` call triggers. Nothing
 * is written again, so a hook sees exactly what the cell left and no change made meanwhile can be overwritten.
 */
export async function reportWrittenFiles(
	selection: WrittenFilesSelection,
	deps: WriteHookDeps,
): Promise<WrittenFilesReport | undefined> {
	const { listed, total } = selection;
	if (total === 0) return undefined;
	const hookOutputs: { path: string; text: string }[] = [];
	const hookFailures: { path: string; error: string }[] = [];
	const fail = (path: string, error: string) =>
		hookFailures.push({ path, error: capCodePoints(error, HOOK_ERROR_CODE_POINTS) });
	let outputBudget = HOOK_OUTPUT_CELL_CODE_POINTS;
	let hooked = 0;
	const report = selection.hooks ? deps.report : undefined;
	const ceded: ChangedFile[] = [];
	for (const file of listed) {
		// Without hooks the selection claimed nothing, so there is nothing to let go of.
		if (report === undefined) break;
		if (deps.signal.aborted) {
			if (deps.skipped(file.absolutePath) === "ceded") ceded.push(file);
			continue;
		}
		const bytes = await deps.fs.read(file.absolutePath, SOURCE_FILE_MAX_BYTES + 1);
		// The cell may have been cancelled during the read: a hook it has not started must not start.
		if (deps.signal.aborted) {
			if (deps.skipped(file.absolutePath) === "ceded") ceded.push(file);
			continue;
		}
		if (bytes === undefined || bytes.length > SOURCE_FILE_MAX_BYTES) {
			// A model call may have taken the file during the read back: then the failure is not this cell's to report.
			if (deps.failed(file.absolutePath) === "ceded") ceded.push(file);
			else fail(file.path, "the file could not be read back for the hooks");
			continue;
		}
		// The one dispatch point: from here the file stays this cell's until its hooks return, even if the cell closes.
		// `report` is called with no await after `start`, so no model call can take the file in between.
		const start = deps.start(file.absolutePath);
		if (start === "ceded") ceded.push(file);
		if (start === "refused") deps.skipped(file.absolutePath);
		if (start !== "started") continue;
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
		}
		// A hook may rewrite the file (a formatter), even one that then failed; that rewrite is not a later cell's write.
		await deps.noteHooked(file.absolutePath);
	}
	// A file a model call took is the call's change: the cell neither lists nor counts it.
	const reported = withoutCeded(selection, ceded);
	if (reported.total === 0) return undefined;
	const files = reported.listed.map((file) => file.path);
	return { files, total: reported.total, hooked, hookOutputs, hookFailures };
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
