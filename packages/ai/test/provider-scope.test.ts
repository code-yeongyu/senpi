import { afterEach, describe, expect, it } from "vitest";
import type { ApiProvider } from "../src/api-registry.ts";
import {
	stream as compatStream,
	getApiProvider,
	registerApiProvider,
	resetApiProviders,
	unregisterApiProviders,
} from "../src/compat.ts";
import type { ImagesApiProvider } from "../src/images-api-registry.ts";
import {
	getImagesApiProvider,
	registerImagesApiProvider,
	resetImagesApiProviders,
} from "../src/images-api-registry.ts";
import {
	bindToProviderScope,
	ProviderScope,
	runWithProviderScope,
	setProviderScopeStrictMode,
} from "../src/node/provider-scope.ts";
import type { Api, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function provider(api: string, label: string): ApiProvider {
	return {
		api,
		stream: () => providerStream(label),
		streamSimple: () => providerStream(label),
	};
}

function imagesProvider(api: string, label: string): ImagesApiProvider {
	return {
		api,
		generateImages: async () => ({
			api,
			provider: "scope-test",
			model: "scope-test",
			output: [{ type: "text", text: label }],
			stopReason: "stop",
			timestamp: Date.now(),
		}),
	};
}

function providerStream(label: string): AssistantMessageEventStream {
	const output = new AssistantMessageEventStream();
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: label }],
		api: "scope-test",
		provider: "scope-test",
		model: "scope-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
	output.push({ type: "start", partial: message });
	output.push({ type: "done", reason: "stop", message });
	output.end(message);
	return output;
}

const context: Context = { messages: [] };

afterEach(() => {
	setProviderScopeStrictMode(false);
	resetApiProviders();
});

describe("node provider scopes", () => {
	it("isolates concurrent registrations with the same api id", async () => {
		const first = new ProviderScope();
		const second = new ProviderScope();
		let release!: () => void;
		const bothRegistered = new Promise<void>((resolve) => (release = resolve));
		let registrations = 0;

		const registerAndResolve = (scope: ProviderScope, label: string) =>
			runWithProviderScope(scope, async () => {
				registerApiProvider(provider("scope-test", label), label);
				if (++registrations === 2) release();
				await bothRegistered;
				return getApiProvider("scope-test")
					?.stream({ api: "scope-test" } as Model<Api>, context)
					.result();
			});

		const [firstResult, secondResult] = await Promise.all([
			registerAndResolve(first, "first"),
			registerAndResolve(second, "second"),
		]);

		expect(firstResult?.content[0]).toMatchObject({ text: "first" });
		expect(secondResult?.content[0]).toMatchObject({ text: "second" });
	});

	it("resets only the active scope", () => {
		const first = new ProviderScope();
		const second = new ProviderScope();

		runWithProviderScope(first, () => registerApiProvider(provider("scope-reset", "first"), "first"));
		runWithProviderScope(second, () => registerApiProvider(provider("scope-reset", "second"), "second"));
		runWithProviderScope(first, () => resetApiProviders());

		expect(runWithProviderScope(first, () => getApiProvider("scope-reset"))).toBeUndefined();
		expect(runWithProviderScope(second, () => getApiProvider("scope-reset"))).toBeDefined();
	});

	it("isolates concurrent image registrations with the same api id", async () => {
		const first = new ProviderScope();
		const second = new ProviderScope();
		let release!: () => void;
		const bothRegistered = new Promise<void>((resolve) => (release = resolve));
		let registrations = 0;

		const registerAndResolve = (scope: ProviderScope, label: string) =>
			runWithProviderScope(scope, async () => {
				registerImagesApiProvider(imagesProvider("scope-images-test", label), label);
				if (++registrations === 2) release();
				await bothRegistered;
				return getImagesApiProvider("scope-images-test")?.generateImages({ api: "scope-images-test" } as never, {
					input: [],
				});
			});

		const [firstResult, secondResult] = await Promise.all([
			registerAndResolve(first, "first"),
			registerAndResolve(second, "second"),
		]);

		expect(firstResult?.output[0]).toMatchObject({ text: "first" });
		expect(secondResult?.output[0]).toMatchObject({ text: "second" });
	});

	it("resets image providers only in the active scope", () => {
		const first = new ProviderScope();
		const second = new ProviderScope();
		runWithProviderScope(first, () => registerImagesApiProvider(imagesProvider("scope-images-reset", "first")));
		runWithProviderScope(second, () => registerImagesApiProvider(imagesProvider("scope-images-reset", "second")));
		runWithProviderScope(first, () => resetImagesApiProviders());

		expect(runWithProviderScope(first, () => getImagesApiProvider("scope-images-reset"))).toBeUndefined();
		expect(runWithProviderScope(second, () => getImagesApiProvider("scope-images-reset"))).toBeDefined();
	});

	it("throws when a bound callback looks up a closed scope", () => {
		const scope = new ProviderScope();
		const lookup = runWithProviderScope(scope, () => bindToProviderScope(() => getApiProvider("scope-test")));
		scope.close();

		expect(lookup).toThrow("Provider scope is closed");
	});

	it("unregisters after await only from its own scope", async () => {
		const first = new ProviderScope();
		const second = new ProviderScope();
		runWithProviderScope(first, () => registerApiProvider(provider("scope-unregister", "first"), "shared"));
		runWithProviderScope(second, () => registerApiProvider(provider("scope-unregister", "second"), "shared"));

		await runWithProviderScope(first, async () => {
			await Promise.resolve();
			unregisterApiProviders("shared");
		});

		expect(runWithProviderScope(first, () => getApiProvider("scope-unregister"))).toBeUndefined();
		expect(runWithProviderScope(second, () => getApiProvider("scope-unregister"))).toBeDefined();
	});

	it("throws no-scope lookups in strict mode", () => {
		setProviderScopeStrictMode(true);
		expect(() => getApiProvider("scope-test")).toThrow("Provider scope is required");
		expect(() => getImagesApiProvider("scope-images-test")).toThrow("Provider scope is required");
	});

	it("keeps builtin dispatch identity while a scope has unrelated overlays", () => {
		const scope = new ProviderScope();
		const builtin = getApiProvider("pi-messages");
		let globalOverrideCalled = false;
		registerApiProvider({
			api: "pi-messages",
			stream: () => {
				globalOverrideCalled = true;
				return providerStream("global override");
			},
			streamSimple: () => providerStream("global override"),
		});

		runWithProviderScope(scope, () => {
			registerApiProvider(provider("scope-unrelated", "overlay"));
			const model = { api: "pi-messages" } as Model<Api>;
			const scoped = getApiProvider(model.api);
			expect(scoped).toBe(builtin);
			const output = compatStream(model, context);
			expect(output).toBeDefined();
		});

		expect(globalOverrideCalled).toBe(false);
	});
});
