import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode.selectModelFromUi feedback ordering", () => {
	test("#given a slow provider auth check #when a model is selected #then the selector is released before setModel resolves", async () => {
		const order: string[] = [];
		let releaseSetModel: (() => void) | undefined;
		const setModelGate = new Promise<void>((resolve) => {
			releaseSetModel = resolve;
		});

		const fakeThis: any = {
			session: {
				setModel: vi.fn(async () => {
					order.push("setModel:start");
					await setModelGate;
					order.push("setModel:end");
					return undefined;
				}),
			},
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn((message: string) => order.push(`status:${message}`)),
			showError: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
			checkDaxnutsEasterEgg: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		const done = () => order.push("selector:released");
		const model = { id: "beta-1", provider: "faux" };

		const pending = (InteractiveMode as any).prototype.selectModelFromUi.call(fakeThis, model, done);
		await new Promise((resolve) => setImmediate(resolve));

		// The overlay is torn down on Enter, so the selector must be released while
		// setModel is still pending; otherwise the TUI shows a stale frozen frame
		// for the entire provider auth round trip.
		expect(order).toContain("selector:released");
		expect(order).not.toContain("setModel:end");
		expect(order.indexOf("selector:released")).toBeLessThan(order.indexOf("setModel:start"));

		releaseSetModel?.();
		await pending;
		expect(order.indexOf("selector:released")).toBeLessThan(order.indexOf("setModel:end"));
	});
});
