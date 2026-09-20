import { resolveToCwd } from "../../../core/tools/path-utils.ts";
import { findRenderers, grepRenderers, lsRenderers, readRenderers } from "../../../core/tools/renderers/index.ts";
import { getCompactReadClassification } from "../../../core/tools/renderers/read.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

export type RequestedRange = { readonly start: number; readonly end: number | undefined };
export type ExplorationCall = {
	readonly action: "Read" | "Search" | "List";
	readonly path: string;
	readonly pathKey: string;
	readonly query?: string;
	readonly range?: RequestedRange;
	readonly pending: boolean;
	readonly failed: boolean;
	readonly truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function record(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Group only the known built-in presentation; custom and semantic read cards stay intact. */
export function explorationCall(component: ToolExecutionComponent): ExplorationCall | undefined {
	const { identity, state, presentation } = component.presentationSnapshot;
	if (presentation !== "classic") return undefined;
	const renderers = { read: readRenderers, grep: grepRenderers, find: findRenderers, ls: lsRenderers };
	const toolName = identity.toolName;
	if (toolName !== "read" && toolName !== "grep" && toolName !== "find" && toolName !== "ls") return undefined;
	const expected = renderers[toolName];
	const actual = identity.toolDefinition;
	if (actual && (actual.renderCall !== expected.renderCall || actual.renderResult !== expected.renderResult))
		return undefined;
	const args = record(state.args);
	const rawPath = args?.file_path ?? args?.path;
	if (rawPath !== undefined && typeof rawPath !== "string") return undefined;
	if (toolName === "read" && !rawPath) return undefined;
	const path = typeof rawPath === "string" && rawPath ? rawPath : ".";
	if (toolName === "read" && getCompactReadClassification({ path }, identity.cwd)) return undefined;
	const offset = positiveInteger(args?.offset);
	const limit = positiveInteger(args?.limit);
	if ((args?.offset != null && offset === undefined) || (args?.limit != null && limit === undefined)) return undefined;
	const start = offset ?? 1;
	const end = limit === undefined ? undefined : start + limit - 1;
	if (end !== undefined && !Number.isSafeInteger(end)) return undefined;
	const pathKey = resolveToCwd(path, identity.cwd);
	const truncation = record(record(state.result?.details)?.truncation);
	return {
		action: toolName === "read" ? "Read" : toolName === "grep" ? "Search" : "List",
		path: formatPathRelativeToCwdOrAbsolute(pathKey, identity.cwd),
		pathKey,
		query: typeof args?.pattern === "string" ? args.pattern : undefined,
		range: toolName === "read" ? { start, end } : undefined,
		pending: state.isPartial,
		failed: state.result?.isError ?? false,
		truncated: truncation?.truncated === true,
	};
}

/** Union is requested coverage, never a claim about returned lines or EOF. */
export function requestedRanges(ranges: readonly RequestedRange[]): string {
	const merged: { start: number; end: number | undefined }[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const previous = merged.at(-1);
		if (previous && (previous.end === undefined || range.start <= previous.end + 1)) {
			previous.end =
				previous.end === undefined || range.end === undefined ? undefined : Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	const preview = merged.slice(0, 3).map(({ start, end }) => (end === undefined ? `${start}+` : `${start}-${end}`));
	if (merged.length > 3) preview.push(`+${merged.length - 3} ranges`);
	return preview.join(", ");
}
