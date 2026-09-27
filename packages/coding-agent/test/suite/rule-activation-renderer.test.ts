import { describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import piRulesExtension from "../../src/core/extensions/builtin/rules/index.ts";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { EntryRenderer, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const RULE_ACTIVATION_ENTRY_TYPE = "rule-activation";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

async function rendererFrom(factory: ExtensionFactory): Promise<EntryRenderer | undefined> {
	const extension = await loadExtensionFromFactory(
		factory,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<test:rule-activation>",
	);
	return extension.entryRenderers?.get(RULE_ACTIVATION_ENTRY_TYPE);
}

function renderedText(
	renderer: EntryRenderer,
	data: unknown,
	expanded: boolean,
	width = 100,
): { readonly text: string; readonly lines: readonly string[] } {
	const component = renderer(
		{
			type: "custom",
			id: "activation-entry",
			parentId: null,
			timestamp: "2026-08-04T00:00:00.000Z",
			customType: RULE_ACTIVATION_ENTRY_TYPE,
			data,
		},
		{ expanded },
		theme,
	);
	const lines = component?.render(width) ?? [];
	return { text: lines.join("\n").replace(ANSI_PATTERN, ""), lines };
}

describe("shared rule activation renderer", () => {
	it("#given project-rules loads alone #when its activation entry renders #then the notice is compact and expands matched rule paths", async () => {
		initTheme("dark");
		const renderer = await rendererFrom(piRulesExtension);
		expect(renderer).toBeTypeOf("function");
		if (renderer === undefined) return;
		const data = {
			kind: "project-rules",
			targetPath: "src/lib/proxy/strategy.ts",
			rules: [".omo/rules/typescript.md"],
		};

		const collapsed = renderedText(renderer, data, false);
		const expanded = renderedText(renderer, data, true);

		expect(collapsed.text).toContain("Project rules · src/lib/proxy/strategy.ts");
		expect(collapsed.text).not.toContain(".omo/rules/typescript.md");
		expect(expanded.text).toContain(".omo/rules/typescript.md");
	});

	it("#given TTSR loads alone #when its activation entry renders #then remediation and observed rules are visible", async () => {
		initTheme("dark");
		const renderer = await rendererFrom(ttsrExtension);
		expect(renderer).toBeTypeOf("function");
		if (renderer === undefined) return;

		const rendered = renderedText(
			renderer,
			{
				kind: "ttsr",
				owner: "collapse-repetition",
				rules: ["collapse-repetition"],
				remediation: "nudge",
			},
			true,
		);

		expect(rendered.text).toContain("Stream rule · collapse-repetition");
		expect(rendered.text).toContain("nudge");
		expect(rendered.text).toContain("collapse-repetition");
	});

	it("shows a stopped recovery without claiming another nudge or provider retry", async () => {
		initTheme("dark");
		const renderer = await rendererFrom(ttsrExtension);
		if (renderer === undefined) throw new Error("expected the shared rule activation renderer");
		const rendered = renderedText(
			renderer,
			{
				kind: "ttsr",
				owner: "collapse-repetition",
				rules: ["collapse-repetition"],
				remediation: "stopped",
			},
			true,
		);

		expect(rendered.text).toContain("automatic recovery stopped after another collapse");
		expect(rendered.text).toContain("remediation stopped");
		expect(rendered.text).not.toContain("queued");
		expect(rendered.text).not.toContain("retry started");
	});

	it("#given malformed persisted data #when the shared renderer runs #then it returns no component", async () => {
		initTheme("dark");
		const renderer = await rendererFrom(piRulesExtension);
		expect(renderer).toBeTypeOf("function");
		if (renderer === undefined) return;

		const component = renderer(
			{
				type: "custom",
				id: "malformed-activation",
				parentId: null,
				timestamp: "2026-08-04T00:00:00.000Z",
				customType: RULE_ACTIVATION_ENTRY_TYPE,
				data: { kind: "project-rules", targetPath: 42, rules: [] },
			},
			{ expanded: false },
			theme,
		);

		expect(component).toBeUndefined();
	});
});
