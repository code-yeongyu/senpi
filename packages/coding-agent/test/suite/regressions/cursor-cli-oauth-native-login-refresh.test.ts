import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("Cursor CLI OAuth refresh after provider login", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	async function completeLogin(providerId: string): Promise<ReturnType<typeof vi.spyOn>> {
		harness = await createHarness();
		const runtime = harness.session.modelRuntime;
		const refresh = vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		let markRendered: (() => void) | undefined;
		const rendered = new Promise<void>((resolve) => {
			markRendered = resolve;
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
			ui: { requestRender: vi.fn(() => markRendered?.()) },
		};
		const complete = Reflect.get(InteractiveMode.prototype, "completeProviderAuthentication") as (
			this: object,
			providerId: string,
			providerName: string,
			authType: "oauth" | "api_key",
			previousModel: Model<Api>,
		) => Promise<void>;

		await complete.call(context, providerId, "Provider", "oauth", harness.getModel());
		await rendered;
		return refresh;
	}

	it("refreshes the native and Cursor CLI providers after native Cursor login", async () => {
		const refresh = await completeLogin("cursor");

		expect(refresh).toHaveBeenCalledWith({
			allowNetwork: true,
			providers: ["cursor", "cursor-cli-oauth"],
			signal: expect.any(AbortSignal),
		});
	});

	it("keeps every non-Cursor login scoped to its selected provider", async () => {
		const refresh = await completeLogin("radius");

		expect(refresh).toHaveBeenCalledWith({
			allowNetwork: true,
			providers: ["radius"],
			signal: expect.any(AbortSignal),
		});
	});
});
