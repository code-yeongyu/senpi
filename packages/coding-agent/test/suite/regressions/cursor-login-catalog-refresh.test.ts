import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const cursorModel: Model<"cursor-agent"> = {
	id: "cursor-dynamic",
	name: "Cursor Dynamic",
	api: "cursor-agent",
	provider: "cursor-catalog-test",
	baseUrl: "https://api2.cursor.sh",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

describe("Cursor OAuth catalog refresh", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("enables network model discovery immediately after login", async () => {
		harness = await createHarness();
		const runtime = harness.session.modelRuntime;
		let catalogNetworkAllowed = false;
		const provider: Provider<"cursor-agent"> = {
			id: cursorModel.provider,
			name: "Cursor Catalog Test",
			auth: {
				apiKey: {
					name: "Cursor access token",
					login: async () => ({ type: "api_key", key: "secret" }),
					check: async ({ credential }) =>
						credential?.key ? { type: "api_key", source: "stored token" } : undefined,
					resolve: async ({ credential }) => ({
						auth: { apiKey: credential?.key ?? "" },
						source: "stored token",
					}),
				},
			},
			getModels: () => (catalogNetworkAllowed ? [cursorModel] : []),
			refreshModels: async ({ allowNetwork }) => {
				catalogNetworkAllowed = allowNetwork;
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		await runtime.registerNativeProvider(provider, { refresh: false });
		await runtime.login(provider.id, "api_key", { prompt: async () => "unused", notify: () => {} });
		expect(runtime.getAvailableSnapshot().map((model) => model.id)).not.toContain(cursorModel.id);

		let markRefreshRendered: (() => void) | undefined;
		const refreshRendered = new Promise<void>((resolve) => {
			markRefreshRendered = resolve;
		});
		const context = {
			session: harness.session,
			updateAvailableProviderCount: vi.fn(),
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
			ui: {
				requestRender: vi.fn(() => markRefreshRendered?.()),
			},
		};
		const complete = Reflect.get(InteractiveMode.prototype, "completeProviderAuthentication") as (
			this: object,
			providerId: string,
			providerName: string,
			authType: "oauth" | "api_key",
			previousModel: Model<Api>,
		) => Promise<void>;

		await complete.call(context, provider.id, provider.name, "oauth", harness.getModel());
		await refreshRendered;

		expect(catalogNetworkAllowed).toBe(true);
		expect(runtime.getAvailableSnapshot().map((model) => model.id)).toContain(cursorModel.id);
	});
});
