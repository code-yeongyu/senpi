import { afterEach, describe, expect, it } from "vitest";
import {
	complete,
	fauxAssistantMessage,
	getApiProvider,
	registerApiProvider,
	registerFauxProvider,
	resetApiProviders,
} from "../src/compat.ts";
import { ProviderScope, runWithProviderScope } from "../src/node/provider-scope.ts";
import type { Context } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
	resetApiProviders();
});

describe("faux provider across an API registry reset (senpi#2542)", () => {
	it("keeps answering after resetApiProviders", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("still here")]);

		resetApiProviders();
		const response = await complete(registration.getModel(), context);

		expect(response.content).toEqual([{ type: "text", text: "still here" }]);
		expect(registration.state.callCount).toBe(1);
	});

	it("keeps a second registration's queued replies separate after the reset", async () => {
		const first = registerFauxProvider();
		const second = registerFauxProvider();
		registrations.push(first, second);
		first.setResponses([fauxAssistantMessage("from first")]);
		second.setResponses([fauxAssistantMessage("from second")]);

		resetApiProviders();

		expect((await complete(second.getModel(), context)).content).toEqual([{ type: "text", text: "from second" }]);
		expect((await complete(first.getModel(), context)).content).toEqual([{ type: "text", text: "from first" }]);
	});

	it("keeps answering after a reset inside the provider scope it was registered in", async () => {
		const scope = new ProviderScope();
		const registration = runWithProviderScope(scope, () => registerFauxProvider());
		registration.setResponses([fauxAssistantMessage("scoped reply")]);

		const response = await runWithProviderScope(scope, async () => {
			resetApiProviders();
			return complete(registration.getModel(), context);
		});

		expect(response.content).toEqual([{ type: "text", text: "scoped reply" }]);
		runWithProviderScope(scope, () => registration.unregister());
	});

	it("stays invisible to another provider scope after the reset", () => {
		const owner = new ProviderScope();
		const other = new ProviderScope();
		const registration = runWithProviderScope(owner, () => registerFauxProvider());

		runWithProviderScope(owner, () => resetApiProviders());

		expect(runWithProviderScope(other, () => getApiProvider(registration.api))).toBeUndefined();
		expect(runWithProviderScope(owner, () => getApiProvider(registration.api))).toBeDefined();
		runWithProviderScope(owner, () => registration.unregister());
	});

	it("still clears ordinary providers on reset", () => {
		registerApiProvider(
			{
				api: "reset-clears-me",
				stream: () => {
					throw new Error("not called");
				},
				streamSimple: () => {
					throw new Error("not called");
				},
			},
			"ordinary",
		);

		resetApiProviders();

		expect(getApiProvider("reset-clears-me")).toBeUndefined();
	});

	it("gives a builtin API back once a faux override of it is unregistered after a reset", () => {
		const builtin = getApiProvider("openai-completions");
		const override = registerFauxProvider({ api: "openai-completions" });
		registrations.push(override);

		resetApiProviders();
		expect(getApiProvider("openai-completions")).not.toBe(builtin);
		override.unregister();

		expect(getApiProvider("openai-completions")).toBe(builtin);
	});

	it("stops answering once unregistered, even if a reset happened in between", async () => {
		const registration = registerFauxProvider();
		registration.setResponses([fauxAssistantMessage("should not be sent")]);

		resetApiProviders();
		registration.unregister();

		await expect(complete(registration.getModel(), context)).rejects.toThrow(
			`No API provider registered for api: ${registration.api}`,
		);
		expect(registration.state.callCount).toBe(0);
	});
});
