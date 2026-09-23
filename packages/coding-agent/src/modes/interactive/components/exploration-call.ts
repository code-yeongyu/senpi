import { basename } from "node:path";
import { resolveToCwd } from "../../../core/tools/path-utils.ts";
import { findRenderers, grepRenderers, lsRenderers, readRenderers } from "../../../core/tools/renderers/index.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** One exploration call as the collapsed group shows it: an action plus a label, never output. */
export type ExplorationCall = {
	readonly action: "Read" | "Search" | "List";
	/** Read: file basename. Search: the pattern plus ` in <dir>` for an explicit path. List: directory basename. */
	readonly label: string;
	readonly pending: boolean;
	readonly failed: boolean;
};

const BUILT_IN_RENDERERS = { read: readRenderers, grep: grepRenderers, find: findRenderers, ls: lsRenderers };

function stringArg(args: unknown, ...keys: string[]): string | undefined {
	if (args === null || typeof args !== "object") return undefined;
	for (const key of keys) {
		const value: unknown = Reflect.get(args, key);
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

/** Group only the built-in read/grep/find/ls presentation; custom renderers and other tools stay cards. */
export function explorationCall(component: ToolExecutionComponent): ExplorationCall | undefined {
	const { identity, state, presentation } = component.presentationSnapshot;
	if (presentation !== "classic") return undefined;
	const toolName = identity.toolName;
	if (toolName !== "read" && toolName !== "grep" && toolName !== "find" && toolName !== "ls") return undefined;
	const expected = BUILT_IN_RENDERERS[toolName];
	const actual = identity.toolDefinition;
	if (actual && (actual.renderCall !== expected.renderCall || actual.renderResult !== expected.renderResult)) {
		return undefined;
	}
	const pending = state.isPartial;
	const failed = state.result?.isError ?? false;
	const path = stringArg(state.args, "file_path", "path");
	if (toolName === "read") return { action: "Read", label: path ? basename(path) : "", pending, failed };
	if (toolName === "grep") {
		const pattern = stringArg(state.args, "pattern") ?? "";
		const dir = path ? formatPathRelativeToCwdOrAbsolute(resolveToCwd(path, identity.cwd), identity.cwd) : "";
		return { action: "Search", label: dir ? `${pattern} in ${dir}` : pattern, pending, failed };
	}
	return { action: "List", label: (path && basename(path)) || path || ".", pending, failed };
}
