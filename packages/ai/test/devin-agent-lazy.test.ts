import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFauxCore } from "../src/providers/faux.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

beforeEach(() => vi.resetModules());

describe("Devin module override", () => {
	it("loads the concrete provider when no override is installed", async () => {
		// Given
		const lazy = await import("../src/api/devin-agent.lazy.ts");
		const concrete = await import("../src/api/devin-agent.ts");
		// When
		const loaded = await lazy.loadDevinAgentModule();
		// Then
		expect(loaded.stream).toBe(concrete.stream);
		expect(loaded.streamSimple).toBe(concrete.streamSimple);
	});

	it("prefers the installed module when the concrete provider was already loaded", async () => {
		// Given
		const lazy = await import("../src/api/devin-agent.lazy.ts");
		await lazy.loadDevinAgentModule();
		const override = createFauxCore({});
		// When
		lazy.setDevinAgentProviderModule(override);
		// Then
		expect(await lazy.loadDevinAgentModule()).toBe(override);
	});

	it("uses the newest override when a lazy API was created before registration", async () => {
		// Given
		const lazy = await import("../src/api/devin-agent.lazy.ts");
		const api = lazy.devinAgentApi();
		const previous = createFauxCore({});
		const current = createFauxCore({});
		lazy.setDevinAgentProviderModule(previous);
		lazy.setDevinAgentProviderModule(current);
		// When
		await api.streamSimple(current.getModel(), normalizeContext({ messages: [] })).result();
		// Then
		expect(previous.getCallLog()).toHaveLength(0);
		expect(current.getCallLog()).toHaveLength(1);
	});
});
