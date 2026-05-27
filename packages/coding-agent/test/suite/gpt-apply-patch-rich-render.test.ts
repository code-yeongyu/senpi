import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createApplyPatchTool,
	PATCH_PREVIEW_MAX_CHARS,
	PATCH_PREVIEW_MAX_LINES,
	renderPatchPreview,
	truncatePreview,
} from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import type { ToolRenderContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import type { Harness } from "./harness.ts";
import { createHarness } from "./harness.ts";

type ApplyPatchTool = ReturnType<typeof createApplyPatchTool>;
type ApplyPatchArgs = { input: string };
type ApplyPatchState = Record<string, unknown>;

const markerTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	inverse: (text: string) => `<inverse>${text}</inverse>`,
};

const successBg = "\x1b[48;2;40;50;40m";
const bgReset = "\x1b[49m";
const ansiTheme = {
	fg: (_name: string, text: string) => text,
	bg: (name: string, text: string) => {
		const start = name === "toolSuccessBg" ? successBg : "\x1b[48;2;40;40;50m";
		return `${start}${text}${bgReset}`;
	},
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

function createRenderContext(cwd: string, args: ApplyPatchArgs, overrides: Partial<ToolRenderContext> = {}) {
	return {
		args,
		toolCallId: "call-streaming-preview",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: false,
		argsComplete: false,
		isPartial: true,
		expanded: false,
		showImages: true,
		isError: false,
		...overrides,
	} satisfies ToolRenderContext<ApplyPatchState, ApplyPatchArgs>;
}

describe("gpt apply_patch rich TUI rendering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("renders streamed arguments as a rich patch preview before execution starts", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		const args = {
			input: `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** Add File: created.txt
+created
`,
		};
		const tool = createApplyPatchTool();

		const component = tool.renderCall?.(args, theme, createRenderContext(harness.tempDir, args));
		const rendered = stripAnsi(component?.render(120).join("\n") ?? "");

		expect(rendered).toContain("Applying patch");
		expect(rendered).toContain("sample.txt");
		expect(rendered).toContain("- before");
		expect(rendered).toContain("+ after");
		expect(rendered).toContain("created.txt");
	});

	it("keeps the real diff visible after apply_patch finishes", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "sample.txt"), "before\n", "utf-8");
		const args = {
			input: `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** End Patch`,
		};
		const tool = createApplyPatchTool();

		const result = await tool.execute("call-rich-result", args, undefined, undefined, {
			cwd: harness.tempDir,
		} as Parameters<ApplyPatchTool["execute"]>[4]);
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			theme,
			createRenderContext(harness.tempDir, args, { executionStarted: true, argsComplete: true, isPartial: false }),
		);
		const rendered = stripAnsi(component?.render(120).join("\n") ?? "");

		expect(await readFile(path.join(harness.tempDir, "sample.txt"), "utf-8")).toBe("after\n");
		expect(result.details?.preview).toBeDefined();
		expect(rendered).toContain("Applied patch");
		expect(rendered).toContain("sample.txt (+1 -1)");
		expect(rendered).toContain("-1 before");
		expect(rendered).toContain("+1 after");
	});

	it("keeps the changed hunk visible when the applied diff is large", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		const original = `${Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join("\n")}\n`;
		await writeFile(path.join(harness.tempDir, "large.txt"), original, "utf-8");
		const args = {
			input: `*** Begin Patch
*** Update File: large.txt
@@
-line-30
+line-30 updated
*** End Patch`,
		};
		const tool = createApplyPatchTool();

		const result = await tool.execute("call-large-rich-result", args, undefined, undefined, {
			cwd: harness.tempDir,
		} as Parameters<ApplyPatchTool["execute"]>[4]);
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			theme,
			createRenderContext(harness.tempDir, args, { executionStarted: true, argsComplete: true, isPartial: false }),
		);
		const rendered = stripAnsi(component?.render(120).join("\n") ?? "");

		expect(await readFile(path.join(harness.tempDir, "large.txt"), "utf-8")).toContain("line-30 updated");
		expect(rendered).toContain("large.txt (+1 -1)");
		expect(rendered).toContain("-30 line-30");
		expect(rendered).toContain("+30 line-30 updated");
		expect(rendered).not.toContain(" 1 line-1");
	});

	it("keeps truncated previews within the configured line and character caps", () => {
		const plainPreview = truncatePreview(
			Array.from({ length: PATCH_PREVIEW_MAX_LINES + 12 }, (_, index) => `line-${index + 1}`).join("\n"),
		);
		const oversizedPreview = truncatePreview(`${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}\nend`);
		const oversizedChangedHunkPreview = truncatePreview(
			[
				...Array.from({ length: 20 }, (_, index) => ` ${index + 1} line-${index + 1}`),
				`-21 ${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}`,
				"+21 changed",
			].join("\n"),
		);

		expect(plainPreview.split("\n")).toHaveLength(PATCH_PREVIEW_MAX_LINES);
		expect(oversizedPreview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(oversizedPreview).toContain("…");
		expect(oversizedChangedHunkPreview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(oversizedChangedHunkPreview.split("\n").length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_LINES);
	});

	it("renders expanded patch previews with OpenCode-like highlighted diff rows", () => {
		const rendered = renderPatchPreview(
			{
				files: [
					{
						filePath: "src/foo.ts",
						operation: "update",
						diff: "-1 alpha old\n+1 alpha new\n 2 same",
						added: 1,
						removed: 1,
					},
				],
				added: 1,
				removed: 1,
			},
			"/workspace/project",
			markerTheme as never,
			true,
		);

		expect(rendered).toContain("<bg:toolErrorBg><fg:toolDiffRemoved>-</fg:toolDiffRemoved><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<bg:toolSuccessBg><fg:toolDiffAdded>+</fg:toolDiffAdded><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
		expect(rendered).toContain("<fg:toolDiffContext> </fg:toolDiffContext><fg:muted>2</fg:muted> same");
	});

	it("renders partial progress previews with realtime pending status", () => {
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch (1/2)..." }],
			details: {
				progress: { applied: 1, failed: 0, total: 2 },
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "-1 alpha old\n+1 alpha new",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: true },
			markerTheme as never,
			createRenderContext("/workspace/project", { input: "" }, { executionStarted: true, argsComplete: true }),
		);
		const rendered = component?.render(200).join("\n") ?? "";

		expect(rendered).toContain("<bg:toolPendingBg>");
		expect(rendered).toContain("<bold>Applying patch (1/2)</bold>");
		expect(rendered).toContain("• Edited src/foo.ts (+1 -1)");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
	});

	it("preserves the outer success background after highlighted diff row resets", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applied patch" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "+1 const value = 1;",
							added: 1,
							removed: 0,
						},
					],
					added: 1,
					removed: 0,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			ansiTheme as never,
			createRenderContext("/workspace/project", { input: "" }, { executionStarted: true, argsComplete: true }),
		);
		const rendered = component?.render(120).join("\n") ?? "";

		// then
		expect(rendered).toContain(`${bgReset}${successBg}`);
	});
});
