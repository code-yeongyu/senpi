import { basename, extname } from "node:path";
import type { ToolInfo } from "../../types.ts";
import type { ToolSearchDocument } from "./engine/document.ts";
import { deriveExtensionRegistrationId } from "./engine/marker.ts";

/** The search document of a registered extension tool; undefined when it has no name or registration identity. */
export function extensionDocument(tool: ToolInfo): ToolSearchDocument | undefined {
	if (tool.name.length === 0) return undefined;
	const ownerLabel = extensionOwnerLabel(tool);
	const registrationId = deriveExtensionRegistrationId(tool.sourceInfo, tool.name);
	if (registrationId.length === 0) return undefined;
	return {
		name: tool.name,
		label: tool.label,
		aliases: [],
		description: tool.description,
		searchText: tool.searchText,
		keywords: tool.searchKeywords,
		source: "extension",
		group: tool.searchGroup ?? ownerLabel,
		ownerLabel,
		registrationId,
	};
}

function extensionOwnerLabel(tool: ToolInfo): string {
	const fileName = basename(tool.sourceInfo.path);
	const extension = extname(fileName);
	return extension.length === 0 ? fileName : fileName.slice(0, -extension.length);
}
