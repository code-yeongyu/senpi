import { bindToProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { EventLoopSlicer } from "../../../event-loop-slicer.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../types.ts";
import { AnthropicNativeToolSearchAdapter, isMcpNativeToolSearchEnabled } from "./native-search.ts";
import {
	installScopedToolSearchService,
	registerToolSearchServiceForExtensionLoad,
	ToolSearchService,
} from "./service.ts";
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "./tool.ts";

export function createToolSearchExtension(service: ToolSearchService): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		service.bindRuntime(pi);

		// Boot point (senpi#5217): a session boots the catalog at session_start; a runtime with no
		// session boots it at the first tool call a context sees. Each context boots once.
		// A context with no session manager is the runtime itself: one boot per runtime.
		const bootedContexts = new WeakSet<object>();
		const runtimeKey = {};
		pi.on("tool_call", (_event, ctx) => {
			const key = ctx.sessionManager ?? runtimeKey;
			if (bootedContexts.has(key) || service.isDisposed || !canListTools(pi)) return;
			bootedContexts.add(key);
			service.getCatalog();
		});

		pi.on("session_start", async (_event, ctx) => {
			bootedContexts.add(ctx.sessionManager);
			service.beginSession();
			await service.maybeRehydrateFromHistoryInSlices(ctx.sessionManager.getEntries(), new EventLoopSlicer());
		});
		pi.on(
			"context",
			(event) => {
				service.maybeRehydrateFromHistory(event.messages);
			},
			{ mutatesMessages: false },
		);
		// A retired generation's activator declines, so the current generation's activator answers.
		pi.registerLazyToolActivator((toolName) => !service.isDisposed && service.activateTool(toolName));
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

// A runtime whose core is not bound yet cannot list its tools; its catalog boots at a later tool call.
function canListTools(pi: ExtensionAPI): boolean {
	try {
		pi.getAllTools();
		return true;
	} catch {
		return false;
	}
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
	const service = new ToolSearchService(runtime);
	if (hasProviderScope()) installScopedToolSearchService(service);
	registerToolSearchServiceForExtensionLoad(pi, service);
	return createToolSearchExtension(service)(pi);
}

export { getToolSearchService, ToolSearchService } from "./service.ts";
export { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "./tool.ts";
