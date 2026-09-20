import { stripVTControlCharacters } from "node:util";
import { type Container, Text, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { registerReadClassifier } from "../../src/core/tools/read-classifiers.ts";
import { withBuiltInRenderers } from "../../src/core/tools/renderers/index.ts";
import { explorationCall, requestedRanges } from "../../src/modes/interactive/components/exploration-call.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

function card(id: string, path: string, offset?: number, limit?: number, name = "read") {
	return new ToolExecutionComponent(
		name,
		id,
		{ path, offset, limit },
		{},
		withBuiltInRenderers(name, undefined),
		new TUI(new VirtualTerminal(120, 40)),
		process.cwd(),
	);
}
function transcript() {
	return new ExplorationTranscriptContainer({ tailBudget: 60, warmChunkSize: 100, requestRender: () => {} });
}
function text(container: Container, width = 120) {
	return container.render(width).map(stripVTControlCharacters).join("\n");
}

// senpi#1870: requested coverage must remain distinct from actual output/EOF.
describe("exploration range summaries", () => {
	it.each([
		[
			[
				{ start: 1, end: 200 },
				{ start: 201, end: 400 },
				{ start: 401, end: 600 },
			],
			"1-600",
		],
		[
			[
				{ start: 1, end: 20 },
				{ start: 10, end: 30 },
			],
			"1-30",
		],
		[
			[
				{ start: 401, end: 600 },
				{ start: 1, end: 200 },
			],
			"1-200, 401-600",
		],
		[
			[
				{ start: 201, end: undefined },
				{ start: 1, end: 200 },
			],
			"1+",
		],
		[
			[
				{ start: 5, end: 5 },
				{ start: 8, end: 8 },
			],
			"5-5, 8-8",
		],
	] as const)("unions only requested intervals %j", (ranges, expected) => {
		expect(requestedRanges(ranges)).toBe(expected);
	});

	it("keeps same basenames distinct while normalizing equivalent paths", () => {
		const chat = transcript();
		const cards = [
			card("a", "src/../src/sample.ts", 1, 20),
			card("b", "src/sample.ts", 21, 20),
			card("c", "test/sample.ts", 1, 20),
		];
		cards.forEach((component) => {
			component.updateResult({ content: [], isError: false });
			chat.addChild(component);
		});
		try {
			expect(text(chat)).toContain("src/sample.ts (2 reads; requested 1-40)");
			expect(text(chat)).toContain("test/sample.ts (1 read; requested 1-20)");
		} finally {
			chat.dispose();
		}
	});

	it("does not infer returned coverage from requested ranges at EOF or byte truncation", () => {
		const chat = transcript();
		for (const [id, truncated] of [
			["eof", false],
			["bytes", true],
		] as const) {
			const component = card(id, `${id}.ts`, 401, 200);
			component.updateResult({
				content: [{ type: "text", text: "only one actual line" }],
				isError: false,
				details: { truncation: { truncated, outputLines: 1, totalLines: 200, truncatedBy: "bytes" } },
			});
			chat.addChild(component);
		}
		try {
			expect(text(chat).match(/requested 401-600/g)).toHaveLength(2);
			expect(text(chat)).toContain("[truncated]");
			expect(text(chat)).not.toContain("returned");
		} finally {
			chat.dispose();
		}
	});

	it("reclassifies partial paths without absorbing skill, memory, resource or custom renderers", () => {
		const chat = transcript();
		const partial = card("partial", "");
		chat.addChild(partial);
		const unregister = registerReadClassifier(({ absolutePath }) =>
			absolutePath.endsWith("memory.md") ? { kind: "memory", label: "memo" } : undefined,
		);
		try {
			expect(explorationCall(partial)).toBeUndefined();
			partial.updateArgs({ path: "src/a.ts", offset: 1, limit: 20 });
			expect(text(chat)).toContain("requested 1-20");
			for (const path of ["skills/test/SKILL.md", "AGENTS.md", "memory.md"]) {
				partial.updateArgs({ path });
				expect(explorationCall(partial)).toBeUndefined();
			}
			expect(text(chat)).toContain("Recalled");
			const custom = new ToolExecutionComponent(
				"read",
				"custom",
				{ path: "a.ts" },
				{},
				{
					renderCall: () => new Text("semantic custom label", 0, 0),
				},
				new TUI(new VirtualTerminal(80, 40)),
				process.cwd(),
			);
			chat.addChild(custom);
			expect(text(chat)).toContain("semantic custom label");
			expect(explorationCall(custom)).toBeUndefined();
		} finally {
			unregister();
			chat.dispose();
		}
	});

	it("bounds many-call rendering without painting original results and keeps hidden failures visible", () => {
		const chat = transcript();
		const renders = [];
		for (let index = 0; index < 1000; index++) {
			const component = card(String(index), `src/file-${index}.ts`, 1, 200);
			component.updateResult({
				content: [{ type: "text", text: "large result\n".repeat(500) }],
				isError: index === 999,
			});
			renders.push(vi.spyOn(component, "render"));
			chat.addChild(component);
		}
		try {
			expect(chat.render(80).length).toBeLessThanOrEqual(6);
			expect(text(chat, 80)).toContain("1 failed");
			expect(text(chat, 80)).toContain("997 more activities");
			expect(renders.every((render) => render.mock.calls.length === 0)).toBe(true);
			expect(chat.children).toHaveLength(1000);
		} finally {
			chat.dispose();
		}
	});
});
