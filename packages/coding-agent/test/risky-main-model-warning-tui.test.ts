import type { Model } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { isRiskyMainModel, RISKY_MAIN_MODEL_WARNING } from "../src/modes/interactive/risky-main-model-warning.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function model(overrides: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		id: "safe-model",
		name: "Safe Model",
		api: "openai-completions",
		provider: "safe-provider",
		baseUrl: "http://127.0.0.1:18990/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}

function renderAll(container: Container, width = 100): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function warningMethod(): (this: unknown, selectedModel: Model<any>) => void {
	const method = Reflect.get(InteractiveMode.prototype, "showRiskyMainModelWarning");
	if (typeof method !== "function") throw new Error("InteractiveMode.showRiskyMainModelWarning is missing");
	return method;
}

describe("risky main-model warning", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test.each([
		["provider/model identifier", model({ id: "QwEn3-Coder" })],
		["provider name", model({ provider: "MiniMax" })],
		["displayed model label", model({ name: "Hosted MINIMAX M2" })],
	])("matches %s case-insensitively", (_case, selectedModel) => {
		expect(isRiskyMainModel(selectedModel)).toBe(true);
	});

	test("does not match a normal model", () => {
		expect(isRiskyMainModel(model({ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai" }))).toBe(false);
	});

	test.each([model({ id: "minimax-m2", name: "MiniMax M2" }), model({ id: "QWEN3-CODER", name: "Qwen 3 Coder" })])(
		"renders the risky-model warning in a prominent red box for $id",
		(selectedModel) => {
			const fakeThis = {
				chatContainer: new Container(),
				ui: { requestRender: vi.fn() },
			};

			warningMethod().call(fakeThis, selectedModel);

			const rendered = renderAll(fakeThis.chatContainer);
			const plain = stripAnsi(rendered).replace(/\s+/g, " ");
			expect(plain).toContain(RISKY_MAIN_MODEL_WARNING);
			expect(plain).toContain("Risky model warning");
			expect(rendered).toContain(theme.getFgAnsi("error"));
			expect(fakeThis.chatContainer.children).toHaveLength(4);
			expect(fakeThis.ui.requestRender).toHaveBeenCalledExactlyOnceWith();
		},
	);

	test("renders nothing for a normal model", () => {
		const fakeThis = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
		};

		warningMethod().call(fakeThis, model({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }));

		expect(fakeThis.chatContainer.children).toHaveLength(0);
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});

	test("checks a model selected through the full or favorites selector", async () => {
		const selectedModel = model({ id: "qwen3-coder" });
		const fakeThis = {
			session: { setModel: vi.fn(async () => undefined) },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
		};
		const selectModelFromUi = Reflect.get(InteractiveMode.prototype, "selectModelFromUi");
		if (typeof selectModelFromUi !== "function") throw new Error("InteractiveMode.selectModelFromUi is missing");

		await selectModelFromUi.call(fakeThis, selectedModel);

		expect(fakeThis.showRiskyMainModelWarning).toHaveBeenCalledExactlyOnceWith(selectedModel);
	});

	test("checks a model selected by favorite rotation", async () => {
		const selectedModel = model({ id: "MINIMAX-M2" });
		const fakeThis = {
			session: {
				cycleModel: vi.fn(async () => ({ model: selectedModel, thinkingLevel: "off" })),
				favoriteModels: [{ model: selectedModel }],
			},
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
		};
		const cycleModel = Reflect.get(InteractiveMode.prototype, "cycleModel");
		if (typeof cycleModel !== "function") throw new Error("InteractiveMode.cycleModel is missing");

		await cycleModel.call(fakeThis, "forward");

		expect(fakeThis.showRiskyMainModelWarning).toHaveBeenCalledExactlyOnceWith(selectedModel);
	});
});
