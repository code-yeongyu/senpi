import { bindToProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { ExtensionAPI, ExtensionFactory } from "../../types.ts";
import { AnthropicNativeToolSearchAdapter, isMcpNativeToolSearchEnabled } from "./native-search.ts";
import {
	createToolSearchActivator,
	installLocalToolSearchService,
	installScopedToolSearchService,
	ToolSearchService,
} from "./service.ts";
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
		pi.registerLazyToolActivator(createToolSearchActivator(service));
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
			onFallback: (reason) => service.noteNativeInjectionFailure(reason),
		});
		pi.on("before_provider_request", (event, ctx) =>
			nativeAdapter.applyBeforeRequest(event.model ?? ctx.model, event.payload),
		);
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
	// A prepared resume is not the active runtime yet. Its callbacks must
	// never rebind the live catalog to an extension generation that may be rejected.
	const service = new ToolSearchService(runtime);
	if (sessionOwned) pi.on("session_start", () => installScopedToolSearchService(service));
	else pi.on("session_start", () => installLocalToolSearchService(service));
	return createToolSearchExtension(service)(pi);
}

export { getToolSearchService, ToolSearchService } from "./service.ts";
export { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "./tool.ts";
