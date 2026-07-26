import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList, type SelectListRowParts, type SelectListTheme } from "../src/components/select-list.ts";

/**
 * Presentation seam for select-list rows (grok-neo todo G6).
 *
 * A theme may provide `renderRow` to compose each item row itself, receiving
 * the selection prefix (already styled via the theme's `selectedPrefix` for
 * selected rows), the truncated primary label, and the padded description.
 * This lets a theme colour the prefix independently of the selected-row
 * background — impossible with the legacy whole-line `selectedText` wrap.
 */
describe("SelectList renderRow presentation seam", () => {
	it("styles the selected-row prefix independently of the row background", () => {
		const seamTheme: SelectListTheme = {
			selectedPrefix: (text) => `[BLUE]${text}[/BLUE]`,
			selectedText: (text) => `[S]${text}[/S]`,
			description: (text) => `[D]${text}[/D]`,
			scrollInfo: (text) => `[I]${text}[/I]`,
			noMatch: (text) => `[N]${text}[/N]`,
			renderRow: ({ prefix, primary, description, isSelected }) =>
				isSelected ? `[BG]${prefix}${primary}${description ?? ""}[/BG]` : `${prefix}${primary}${description ?? ""}`,
		};

		const list = new SelectList(
			[
				{ value: "help", label: "help", description: "Show help" },
				{ value: "quit", label: "quit", description: "Exit the app" },
			],
			5,
			seamTheme,
		);

		const rendered = list.render(80);

		// Selected row: prefix carries the BLUE selectedPrefix styling inside the
		// row-background wrap — the legacy path would have swallowed the prefix
		// into a single selectedText("→ help ...") call.
		assert.strictEqual(rendered[0], `[BG][BLUE]→ [/BLUE]help${" ".repeat(28)}Show help[/BG]`);
		assert.strictEqual(rendered[1], `  quit${" ".repeat(28)}Exit the app`);
	});

	it("passes the raw prefix for unselected rows and omits the description part at narrow width", () => {
		const seen: SelectListRowParts[] = [];
		const seamTheme: SelectListTheme = {
			selectedPrefix: (text) => `[BLUE]${text}[/BLUE]`,
			selectedText: (text) => `[S]${text}[/S]`,
			description: (text) => `[D]${text}[/D]`,
			scrollInfo: (text) => `[I]${text}[/I]`,
			noMatch: (text) => `[N]${text}[/N]`,
			renderRow: (parts) => {
				seen.push(parts);
				return `ROW|${parts.prefix}|${parts.primary}|${parts.description ?? "-"}|${parts.isSelected}`;
			},
		};

		const items = [
			{ value: "help", label: "help", description: "Show help" },
			{ value: "quit", label: "quit", description: "Exit the app" },
		];

		// Narrow width (< 40): no description column is computed at all.
		const narrow = new SelectList(items, 5, seamTheme);
		const narrowLines = narrow.render(30);
		assert.deepStrictEqual(narrowLines, ["ROW|[BLUE]→ [/BLUE]|help|-|true", "ROW|  |quit|-|false"]);
		assert.deepStrictEqual(seen, [
			{ prefix: "[BLUE]→ [/BLUE]", primary: "help", description: undefined, isSelected: true },
			{ prefix: "  ", primary: "quit", description: undefined, isSelected: false },
		]);

		// Wide width: the description part carries the column-alignment spacing.
		seen.length = 0;
		const wide = new SelectList(items, 5, seamTheme);
		wide.render(80);
		assert.strictEqual(seen[0]?.description, `${" ".repeat(28)}Show help`);
		assert.strictEqual(seen[1]?.description, `${" ".repeat(28)}Exit the app`);
	});

	it("gives the renderer truncated primaries identical to the legacy path", () => {
		const seen: SelectListRowParts[] = [];
		const seamTheme: SelectListTheme = {
			selectedPrefix: (text) => text,
			selectedText: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
			renderRow: (parts) => {
				seen.push(parts);
				return parts.primary;
			},
		};

		const list = new SelectList(
			[
				{
					value: "very-long-command-name-that-needs-truncation",
					label: "very-long-command-name-that-needs-truncation",
				},
			],
			5,
			seamTheme,
		);
		list.render(40);

		// Plain path at width 40: maxWidth = 40 - 2 - 2 = 36, so the 44-char
		// label is clipped to 36 columns exactly like the legacy renderer.
		assert.strictEqual(seen[0]?.primary, "very-long-command-name-that-needs-tr\x1b[0m");
	});
});
