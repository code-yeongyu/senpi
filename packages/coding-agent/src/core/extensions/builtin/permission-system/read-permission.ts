import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import { getBundledResourceRoots } from "../../../bundled-resources.ts";
import { resolveReadPath } from "../../../tools/path-utils.ts";
import { isExternalPath, toParentDirectoryPattern } from "./external-dir.ts";
import type { PermissionRequest, ToolPermissionParser } from "./parsers.ts";

/** Resolve the same file the read tool will open before classifying its ownership. */
export const parseReadPermission: ToolPermissionParser = (_toolName, input, cwd) => {
	const filePath =
		typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
	if (!filePath) return [{ permission: "read", patterns: ["*"], always: ["*"] }];

	const readPath = resolveReadPath(filePath, cwd);
	const target = realpathWithoutOpen(readPath);
	const request: PermissionRequest = { permission: "read", patterns: [filePath], always: [filePath] };
	if (getBundledResourceRoots().some((root) => !isExternalPath(target, root))) {
		// The service still evaluates denial rules; only an ask result is auto-approved.
		return [
			{
				...request,
				patterns: [readPath],
				always: [readPath],
				autoApproveAsk: true,
				ruleAliases: [...new Set([filePath, readPath, target])],
			},
		];
	}
	if (!isExternalPath(target, cwd)) return [request];
	return [
		request,
		{
			permission: "external_directory",
			patterns: [readPath],
			always: [toParentDirectoryPattern(readPath, "file")],
		},
	];
};
