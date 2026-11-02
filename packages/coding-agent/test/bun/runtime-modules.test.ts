import { normalizeContext } from "@earendil-works/pi-ai";
// Imported at the top level on purpose: these specifiers pull the whole bundled-provider module
// graph (bedrock, the Node-only cursor-agent transport, devin, Bun OAuth). Importing them inside a
// test body makes the body wait on the shared Vitest transform pipeline, and under a loaded shard
// that wait is charged to the per-test timeout. At the top level it happens during collection.
import {
	bedrockConverseStreamApi,
	loadCursorAgentModule,
	loadDevinAgentModule,
	setBedrockProviderModule,
	setCursorAgentProviderModule,
	setDevinAgentProviderModule,
} from "@earendil-works/pi-ai/compat";
import { cursorAgentProviderModule } from "@earendil-works/pi-ai/cursor-agent-provider";
import { devinProviderModule } from "@earendil-works/pi-ai/devin-provider";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { registerBunRuntimeModules } from "../../src/bun/runtime-modules.ts";

// The registration flag lives in the module, so the two cases share one instance by design:
// the first case observes the first registration, the second observes a repeated one.
describe("Bun runtime module registration", () => {
	it("installs the statically exported providers when called", async () => {
		// When
		const result = registerBunRuntimeModules();
		// Then
		expect(result).toBeUndefined();
		expect(await loadCursorAgentModule()).toBe(cursorAgentProviderModule);
		expect(await loadDevinAgentModule()).toBe(devinProviderModule);
	});

	it("preserves subsequent overrides when registration is repeated", async () => {
		// Given
		registerBunRuntimeModules();
		const bedrock = createFauxCore({});
		const cursor = { ...createFauxCore({}), fetchCursorUsableModels: async () => [] };
		const devin = createFauxCore({});
		setBedrockProviderModule(bedrock);
		setCursorAgentProviderModule(cursor);
		setDevinAgentProviderModule(devin);
		// When
		registerBunRuntimeModules();
		await bedrockConverseStreamApi()
			.streamSimple(bedrock.getModel(), normalizeContext({ messages: [] }))
			.result();
		// Then
		expect(bedrock.getCallLog()).toHaveLength(1);
		expect(await loadCursorAgentModule()).toBe(cursor);
		expect(await loadDevinAgentModule()).toBe(devin);
	});
});
