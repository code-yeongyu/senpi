import { Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as TUI;
}

describe("ToolExecutionComponent render signatures", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("reuses settled signatures across redraws and resize, but refreshes notified mutations", () => {
		const args = { value: "args-before" };
		const details = { value: "result-before" };
		const serializeArgs = vi.fn(() => ({ value: args.value }));
		const serializeDetails = vi.fn(() => ({ value: details.value }));
		Object.assign(args, { toJSON: serializeArgs });
		Object.assign(details, { toJSON: serializeDetails });
		let invalidate: (() => void) | undefined;
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-stable-render-signature",
			args,
			{},
			{
				renderShell: "self",
				renderCall: () => new Text(args.value, 0, 0),
				renderResult: (_result, _options, _theme, context) => {
					invalidate = context.invalidate;
					return new Text(details.value, 0, 0);
				},
			},
			createFakeTui(),
			process.cwd(),
		);
		const result = { content: [], details, isError: false };

		try {
			component.updateResult(result, false);
			serializeArgs.mockClear();
			serializeDetails.mockClear();
			for (const width of [120, 120, 60, 60, 120]) {
				const rendered = component.render(width).join("\n");
				expect(rendered).toContain("args-before");
				expect(rendered).toContain("result-before");
			}
			expect(serializeArgs).not.toHaveBeenCalled();
			expect(serializeDetails).not.toHaveBeenCalled();

			args.value = "args-after";
			component.updateArgs(args);
			expect(serializeArgs).toHaveBeenCalled();
			expect(component.render(120).join("\n")).toContain("args-after");

			details.value = "result-after";
			component.updateResult(result, false);
			expect(component.render(120).join("\n")).toContain("result-after");

			details.value = "result-invalidated";
			if (!invalidate) throw new Error("Result renderer did not receive its invalidation callback");
			invalidate();
			expect(component.render(120).join("\n")).toContain("result-invalidated");
		} finally {
			component.dispose();
		}
	});

	test("does not stringify full image results while computing render cache signatures", () => {
		const imageData = `image-data:${"a".repeat(64 * 1024)}`;
		const detailsData = `details-data:${"b".repeat(64 * 1024)}`;
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-large-image-result",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		const originalStringify = JSON.stringify;
		const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
			const rendered = originalStringify(value, replacer, space);
			if (rendered?.includes(imageData) || rendered?.includes(detailsData)) {
				throw new Error("render signature should not JSON.stringify full image payloads");
			}
			return rendered;
		});

		try {
			expect(() =>
				component.updateResult(
					{
						content: [{ type: "image", data: imageData, mimeType: "image/png" }],
						details: {
							screenshotMetadata: {
								data: detailsData,
								width: 1024,
								height: 768,
							},
						},
						isError: false,
					},
					false,
				),
			).not.toThrow();
			expect(() => component.render(120)).not.toThrow();
		} finally {
			stringifySpy.mockRestore();
		}
	});

	test("bounds large image result signature work across repeated renders", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-repeated-large-image-result",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const charCodeSpy = vi.spyOn(String.prototype, "charCodeAt");

		try {
			component.updateResult(
				{
					content: [{ type: "image", data: `image-data:${"a".repeat(64 * 1024)}`, mimeType: "image/png" }],
					details: {
						screenshotMetadata: {
							data: `details-data:${"b".repeat(64 * 1024)}`,
							width: 1024,
							height: 768,
						},
					},
					isError: false,
				},
				false,
			);
			component.render(120);
			component.render(120);

			expect(charCodeSpy.mock.calls.length).toBeLessThan(4_000);
		} finally {
			charCodeSpy.mockRestore();
		}
	});
});
