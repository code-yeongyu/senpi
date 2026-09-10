import { AsyncResource } from "node:async_hooks";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import { getToolSearchService } from "../../../src/core/extensions/builtin/tool-search/service.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { Extension, ToolInfo } from "../../../src/core/extensions/types.ts";

function toolRuntime(name: string) {
	const runtime = createExtensionRuntime();
	let active: string[] = [];
	runtime.getAllTools = (): ToolInfo[] => [
		{
			name,
			label: name,
			description: `${name} searchable tool`,
			parameters: Type.Object({}),
			sourceInfo: { path: `/test/${name}.ts`, source: "test", scope: "temporary", origin: "top-level" },
			exposure: "search",
			searchKeywords: [],
			allowLazyActivation: true,
		},
	];
	runtime.getActiveTools = () => [...active];
	runtime.setActiveTools = (names) => {
		active = [...names];
	};
	return runtime;
}

async function attach(extension: Extension) {
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "resume" }, { sessionManager: { getEntries: () => [] } });
	}
}

// PR1473 g4Vu9: actual factory, scoped service, lazy activation and native diagnostics.
it.each(["discarded catalog", "discarded diagnostic", "accepted"])(
	"PR1473 g4Vu9: %s retains the correct tool-search owner",
	async (probe) => {
		const resource = new AsyncResource("pr1473-tool-search");
		const scope = new ProviderScope();
		const liveRuntime = toolRuntime("live_hidden");
		const candidateRuntime = toolRuntime("candidate_hidden");
		try {
			await resource.runInAsyncScope(() =>
				runWithProviderScope(scope, async () => {
					const live = await loadExtensionFromFactory(
						toolSearchExtension,
						process.cwd(),
						createEventBus(),
						liveRuntime,
						"<builtin:tool-search>",
					);
					await attach(live);
					const liveService = getToolSearchService();
					expect(liveService.activateTool("live_hidden")).toBe(true);
					liveRuntime.setActiveTools([]);
					liveService.noteNativeInjectionFailure("live-native-failure");

					const candidate = await loadExtensionFromFactory(
						toolSearchExtension,
						process.cwd(),
						createEventBus(),
						candidateRuntime,
						"<builtin:tool-search>",
					);
					if (probe === "accepted") {
						await attach(candidate);
						expect(getToolSearchService().activateTool("candidate_hidden")).toBe(true);
						expect(candidateRuntime.getActiveTools()).toContain("candidate_hidden");
						expect(getToolSearchService().activateTool("live_hidden")).toBe(false);
					} else {
						candidateRuntime.invalidate();
						if (probe === "discarded catalog") {
							expect(getToolSearchService().activateTool("live_hidden")).toBe(true);
							expect(liveRuntime.getActiveTools()).toContain("live_hidden");
						} else {
							expect(getToolSearchService().takeNativeInjectionFailure()).toBe("live-native-failure");
						}
					}
				}),
			);
		} finally {
			liveRuntime.invalidate();
			candidateRuntime.invalidate();
			resource.emitDestroy();
		}
	},
);
