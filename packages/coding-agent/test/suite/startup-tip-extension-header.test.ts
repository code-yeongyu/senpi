import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { appendStartupHeader } from "../../src/modes/interactive/tips/startup-header.ts";

const INTERACTIVE_MODE_SOURCE = readFileSync(
	fileURLToPath(new URL("../../src/modes/interactive/interactive-mode.ts", import.meta.url)),
	"utf8",
);

function renderAll(container: Container): string {
	return container.render(120).flat().join("\n");
}

describe("startup tip survives an extension header override", () => {
	test("the tip is never interpolated into the built-in header text", () => {
		// The header text is built on demand from thunks so it follows theme changes (upstream sync, L6a).
		const logoToken = ["$", "{logo()}"].join("");
		const expandedToken = ["$", "{expandedInstructions()}"].join("");
		const headerClosures = INTERACTIVE_MODE_SOURCE.split("\n").filter(
			(line) => line.includes(logoToken) || line.includes(expandedToken),
		);

		expect(headerClosures.length).toBeGreaterThan(0);
		for (const closure of headerClosures) {
			expect(closure).not.toContain("tipLine");
		}
	});

	test("keeps the tip line after an extension replaces the built-in header", () => {
		const headerContainer = new Container();
		const builtInHeader = new Text("pi v2026.7.27\nctrl+c to interrupt", 1, 0);
		appendStartupHeader(headerContainer, builtInHeader, "Tip: Rotate favorites with ctrl+p.");

		expect(renderAll(headerContainer)).toContain("Tip: Rotate favorites with ctrl+p.");

		const fakeThis = {
			builtInHeader,
			customHeader: undefined as unknown,
			headerContainer,
			toolOutputExpanded: false,
			ui: { requestRender: vi.fn() },
		};
		const setExtensionHeader = Reflect.get(InteractiveMode.prototype, "setExtensionHeader") as (
			this: typeof fakeThis,
			factory: (() => { render: () => string[]; invalidate: () => void }) | undefined,
		) => void;

		setExtensionHeader.call(fakeThis, () => ({
			render: () => ["Prompt preset: fallback (senpi-current)"],
			invalidate: () => {},
		}));

		const rendered = renderAll(headerContainer);
		expect(rendered).toContain("Prompt preset: fallback (senpi-current)");
		expect(rendered).toContain("Tip: Rotate favorites with ctrl+p.");
		expect(rendered).not.toContain("ctrl+c to interrupt");
	});

	test("adds no tip child when there is no tip to show", () => {
		const headerContainer = new Container();
		const builtInHeader = new Text("pi v2026.7.27", 1, 0);
		const tip = appendStartupHeader(headerContainer, builtInHeader, undefined);

		expect(tip).toBeUndefined();
		expect(headerContainer.children).toHaveLength(3);
	});
});
