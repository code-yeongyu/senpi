import { bindToProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { ExtensionAPI, ExtensionFactory } from "../../types.ts";
import { AnthropicNativeToolSearchAdapter, isMcpNativeToolSearchEnabled } from "./native-search.ts";
import { getToolSearchService, installScopedToolSearchService, ToolSearchService } from "./service.ts";
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "./tool.ts";

export function createToolSearchExtension(service: ToolSearchService): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		service.bindRuntime(pi);

		pi.on("session_start", (_event, ctx) => {
			service.beginSession();
			service.maybeRehydrateFromHistory(ctx.sessionManager.getEntries());
		});
		pi.on("context", (event) => {
			service.maybeRehydrateFromHistory(event.messages);
		});
		pi.registerLazyToolActivator((toolName) => service.activateTool(toolName));
		let toolRegistered = false;
		service.bindToolRegistrar(() => {
			if (toolRegistered) return;
			toolRegistered = true;
			pi.registerTool(createToolSearchTool(service));
		});

		const nativeAdapter = new AnthropicNativeToolSearchAdapter({
			enabled: () => {
				const active = new Set(pi.getActiveTools());
				return service
					.getCatalog()
					.some(
						(doc) =>
							(doc.source === "extension" && !active.has(doc.name)) ||
							(doc.source === "mcp" && isMcpNativeToolSearchEnabled()),
					);
			},
			getCatalog: () => service.getCatalog(),
			getToolDefinition: (name) => {
				const tool = pi.getAllTools().find((candidate) => candidate.name === name);
				return tool === undefined ? undefined : { description: tool.description, parameters: tool.parameters };
			},
			isDeferrable: (name) => {
				const doc = service.getCatalog().find((candidate) => candidate.name === name);
				if (doc?.source === "mcp") return isMcpNativeToolSearchEnabled();
				return doc?.source === "extension" && !pi.getActiveTools().includes(name);
			},
			searchToolName: TOOL_SEARCH_TOOL_NAME,
		});
		pi.on("before_provider_request", (event, ctx) => nativeAdapter.applyBeforeRequest(ctx.model?.api, event.payload));
		pi.on("after_provider_response", (event) => nativeAdapter.noteResponseStatus(event.status));
	};
}

function hasProviderScope(): boolean {
	try {
		bindToProviderScope(() => undefined);
		return true;
	} catch {
		return false;
	}
}

export default function toolSearchExtension(pi: ExtensionAPI): void | Promise<void> {
	const runtime = {
		getAllTools: () => pi.getAllTools(),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names: readonly string[]) => pi.setActiveTools([...names]),
	};
	const sessionOwned = hasProviderScope();
	const service = sessionOwned ? new ToolSearchService(runtime) : getToolSearchService(runtime);
	if (sessionOwned) installScopedToolSearchService(service);
	return createToolSearchExtension(service)(pi);
}

export { getToolSearchService, ToolSearchService } from "./service.ts";
export { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "./tool.ts";
