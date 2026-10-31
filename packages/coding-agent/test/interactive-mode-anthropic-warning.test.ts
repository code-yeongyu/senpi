import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function createSettingsManager(warnings: { anthropicExtraUsage?: boolean } = {}) {
	return {
		getWarnings: vi.fn().mockReturnValue(warnings),
	};
}

function createModelRuntime(credential: { type: "oauth" } | undefined, apiKey?: string) {
	return {
		checkAuth: vi.fn().mockResolvedValue(credential),
		getAuth: vi.fn().mockResolvedValue(apiKey ? { auth: { apiKey } } : undefined),
	};
}

describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	test("does not read the API key: an sk-ant-oat key is refused by the provider, not warned about (senpi#5131)", async () => {
		const modelRuntime = createModelRuntime(undefined, "sk-ant-oat01-test");
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});

	test("warns once when Anthropic OAuth is stored even if token refresh lookup would fail", async () => {
		const modelRuntime = createModelRuntime({ type: "oauth" });
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});

	test("does not warn for non-Anthropic models", async () => {
		const modelRuntime = createModelRuntime(undefined);
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "openai",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});

	test("does not warn when Anthropic extra usage warning is disabled", async () => {
		const modelRuntime = createModelRuntime(undefined);
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager({ anthropicExtraUsage: false }),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(modelRuntime.checkAuth).not.toHaveBeenCalled();
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});
});
