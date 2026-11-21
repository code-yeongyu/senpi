import { createAssistantMessageEventStream, type Model, normalizeContext } from "@earendil-works/pi-ai";
import type { ModelEgress, StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createDirectEgress } from "../../src/core/egress/direct.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";

describe("DirectEgress (fused / one-machine)", () => {
	it("hands back the very stream function it was given", () => {
		const streamFn: StreamFn = () => createAssistantMessageEventStream();
		expect(createDirectEgress({ streamFn }).stream).toBe(streamFn);
	});

	it("passes arguments and the returned stream through by reference", async () => {
		const returned = createAssistantMessageEventStream();
		const streamFn = vi.fn<StreamFn>(() => returned);
		const egress = createDirectEgress({ streamFn });
		const model = { id: "m", provider: "p" } as Model<"openai-completions">;
		const context = normalizeContext({ messages: [] });
		const options = { sessionId: "s" };
		expect(await egress.stream(model, context, options)).toBe(returned);
		expect(streamFn).toHaveBeenCalledTimes(1);
		const [calledModel, calledContext, calledOptions] = streamFn.mock.calls[0] ?? [];
		expect(calledModel).toBe(model);
		expect(calledContext).toBe(context);
		expect(calledOptions).toBe(options);
	});

	it("routes every provider direct for the fused reason and serves now", () => {
		const egress = createDirectEgress({ streamFn: () => createAssistantMessageEventStream() });
		for (const providerId of ["anthropic", "openai", "a-custom-provider", ""]) {
			expect(egress.routeFor(providerId)).toStrictEqual({ route: "direct", reason: "fused", servedNow: true });
		}
	});

	it("can be backed by a model runtime's streamSimple without another call site", () => {
		const returned = createAssistantMessageEventStream();
		const runtime = { streamSimple: vi.fn<ModelRuntime["streamSimple"]>(() => returned) };
		const backed: ModelEgress = createDirectEgress({
			streamFn: (model, context, options) => runtime.streamSimple(model, context, options),
		});
		const model = { id: "m", provider: "p" } as Model<"openai-completions">;
		expect(backed.stream(model, normalizeContext({ messages: [] }))).toBe(returned);
		expect(runtime.streamSimple).toHaveBeenCalledTimes(1);
	});
});
