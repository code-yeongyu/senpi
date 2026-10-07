import { normalizeContext } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());

describe("Bun runtime module registration", () => {
	it("installs the statically exported providers when called", async () => {
		// Given
		const { registerBunRuntimeModules } = await import("../../src/bun/runtime-modules.ts");
		const { loadCursorAgentModule, loadDevinAgentModule } = await import("@earendil-works/pi-ai/compat");
		const { cursorAgentProviderModule } = await import("@earendil-works/pi-ai/cursor-agent-provider");
		const { devinProviderModule } = await import("@earendil-works/pi-ai/devin-provider");
		// When
		const result = registerBunRuntimeModules();
		// Then
		expect(result).toBeUndefined();
		expect(await loadCursorAgentModule()).toBe(cursorAgentProviderModule);
		expect(await loadDevinAgentModule()).toBe(devinProviderModule);
	});

	it("preserves subsequent overrides when registration is repeated", async () => {
		// Given
		const { registerBunRuntimeModules } = await import("../../src/bun/runtime-modules.ts");
		const compat = await import("@earendil-works/pi-ai/compat");
		const { createFauxCore } = await import("@earendil-works/pi-ai/providers/faux");
		registerBunRuntimeModules();
		const bedrock = createFauxCore({});
		const cursor = { ...createFauxCore({}), fetchCursorUsableModels: async () => [] };
		const devin = createFauxCore({});
		compat.setBedrockProviderModule(bedrock);
		compat.setCursorAgentProviderModule(cursor);
		compat.setDevinAgentProviderModule(devin);
		// When
		registerBunRuntimeModules();
		await compat
			.bedrockConverseStreamApi()
			.streamSimple(bedrock.getModel(), normalizeContext({ messages: [] }))
			.result();
		// Then
		expect(bedrock.getCallLog()).toHaveLength(1);
		expect(await compat.loadCursorAgentModule()).toBe(cursor);
		expect(await compat.loadDevinAgentModule()).toBe(devin);
	});
});
