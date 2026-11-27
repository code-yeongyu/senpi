import { realpathWithoutOpenWith } from "../../../../utils/paths.ts";
import { getBundledResourceRoots } from "../../../bundled-resources.ts";
import { resolveReadPathWith } from "../../../tools/path-utils.ts";
import { isExternalPath, resolveExternalPath, toParentDirectoryPattern } from "./external-dir.ts";
import type { PermissionRequest, ToolPermissionParser } from "./parsers.ts";
import { currentPathFacts } from "./path-facts.ts";

/** Resolve the same file the read tool will open before classifying its ownership. */
export const parseReadPermission: ToolPermissionParser = (_toolName, input, cwd) => {
	const filePath =
		typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
	if (!filePath) return [{ permission: "read", patterns: ["*"], always: ["*"] }];

	const facts = currentPathFacts();
	const readPath = resolveReadPathWith(filePath, cwd, (path) => facts.exists(path));
	const target = realpathWithoutOpenWith(readPath, facts.walkIo);
	const request: PermissionRequest = {
		permission: "read",
		patterns: [filePath],
		always: [filePath],
		executed: [readPath],
	};
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
	const externalTarget = resolveExternalPath(target, cwd);
	if (externalTarget === undefined) return [request];
	return [
		request,
		{
			permission: "external_directory",
			patterns: [externalTarget],
			always: [toParentDirectoryPattern(externalTarget, "file", filePath)],
			...(readPath !== externalTarget ? { ruleAliases: [readPath] } : {}),
			...(filePath !== externalTarget ? { originalPaths: [filePath] } : {}),
		},
	];
};
