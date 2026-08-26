import { afterEach, describe, expect, it, vi } from "vitest";

import { TtsrManager, type TtsrMatchContext } from "../../src/core/extensions/builtin/ttsr/manager.ts";
import {
	DEFAULT_TTSR_SETTINGS,
	type TtsrRule,
	type TtsrScope,
	type TtsrSettings,
} from "../../src/core/extensions/builtin/ttsr/types.ts";

const ALL_SCOPE: TtsrScope = { allowText: true, allowThinking: true, toolScopes: [] };

function compileCondition(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

function makeRule(name: string, overrides: Partial<TtsrRule> = {}): TtsrRule {
	return {
		name,
		content: `content of ${name}`,
		condition: ["needle"],
		scope: ALL_SCOPE,
		interruptMode: "always",
		source: "project",
		...overrides,
	};
}

function makeManager(settings: TtsrSettings = DEFAULT_TTSR_SETTINGS): TtsrManager {
	return new TtsrManager(settings, compileCondition);
}

function ctx(overrides: Partial<TtsrMatchContext> = {}): TtsrMatchContext {
	return { source: "text", streamKey: "main", ...overrides };
}

function names(rules: readonly TtsrRule[]): string[] {
	return rules.map((rule) => rule.name);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("addRule registration", () => {
	it("dedupes rules by name, keeping the first registration", () => {
		const manager = makeManager();
		expect(manager.addRule(makeRule("dup", { condition: ["first"] }))).toBe(true);
		expect(manager.addRule(makeRule("dup", { condition: ["second"] }))).toBe(false);
		expect(names(manager.getRules())).toEqual(["dup"]);
		expect(names(manager.checkDelta("first", ctx()))).toEqual(["dup"]);
		expect(manager.checkDelta("second", ctx({ streamKey: "other" }))).toEqual([]);
	});

	it("skips a rule whose conditions all fail to compile, with a warning, while others register", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const manager = makeManager();
		expect(manager.addRule(makeRule("bad", { condition: ["(["] }))).toBe(false);
		expect(manager.addRule(makeRule("good"))).toBe(true);
		expect(warn).toHaveBeenCalled();
		expect(names(manager.getRules())).toEqual(["good"]);
	});

	it("keeps valid conditions when a sibling condition is invalid and warns once", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const manager = makeManager();
		expect(manager.addRule(makeRule("mixed", { condition: ["([", "needle"] }))).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(names(manager.checkDelta("needle", ctx()))).toEqual(["mixed"]);
	});

	it("skips a rule whose scope reaches no stream, with a warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const manager = makeManager();
		const scope: TtsrScope = { allowText: false, allowThinking: false, toolScopes: [] };
		expect(manager.addRule(makeRule("deaf", { scope }))).toBe(false);
		expect(warn).toHaveBeenCalled();
		expect(manager.hasRules()).toBe(false);
	});

	it("refuses registration and matching when settings disable ttsr", () => {
		const manager = makeManager({ ...DEFAULT_TTSR_SETTINGS, enabled: false });
		expect(manager.addRule(makeRule("off"))).toBe(false);
		expect(manager.hasRules()).toBe(false);
		expect(manager.checkDelta("needle", ctx())).toEqual([]);
		expect(manager.getRules()).toEqual([]);
	});

	it("does not register rules named in disabledRules", () => {
		const manager = makeManager({ ...DEFAULT_TTSR_SETTINGS, disabledRules: ["disabled-rule"] });
		expect(manager.addRule(makeRule("disabled-rule"))).toBe(false);
		expect(manager.addRule(makeRule("enabled-rule"))).toBe(true);
		expect(names(manager.getRules())).toEqual(["enabled-rule"]);
		expect(names(manager.checkDelta("needle", ctx()))).toEqual(["enabled-rule"]);
	});
});

describe("stream buffers", () => {
	it("isolates buffers per source and per stream key", () => {
		const manager = makeManager();
		manager.addRule(makeRule("iso"));
		expect(manager.checkDelta("nee", ctx({ source: "text", streamKey: "a" }))).toEqual([]);
		expect(manager.checkDelta("dle", ctx({ source: "thinking", streamKey: "a" }))).toEqual([]);
		expect(manager.checkDelta("dle", ctx({ source: "text", streamKey: "b" }))).toEqual([]);
		expect(names(manager.checkDelta("dle", ctx({ source: "text", streamKey: "a" })))).toEqual(["iso"]);
	});

	it("isolates tool buffers per tool call id", () => {
		const manager = makeManager();
		const scope: TtsrScope = { allowText: false, allowThinking: false, toolScopes: [{ toolName: "edit" }] };
		manager.addRule(makeRule("tool-iso", { scope }));
		expect(manager.checkDelta("nee", ctx({ source: "tool", streamKey: "call-1", toolName: "edit" }))).toEqual([]);
		expect(manager.checkDelta("dle", ctx({ source: "tool", streamKey: "call-2", toolName: "edit" }))).toEqual([]);
		expect(names(manager.checkDelta("dle", ctx({ source: "tool", streamKey: "call-1", toolName: "edit" })))).toEqual([
			"tool-iso",
		]);
	});

	it("matches a pattern split across two deltas of one stream", () => {
		const manager = makeManager();
		manager.addRule(makeRule("split"));
		expect(manager.checkDelta("nee", ctx())).toEqual([]);
		expect(names(manager.checkDelta("dle", ctx()))).toEqual(["split"]);
	});

	it("resetBuffers clears partial content so split patterns do not match across turns", () => {
		const manager = makeManager();
		manager.addRule(makeRule("reset"));
		expect(manager.checkDelta("nee", ctx())).toEqual([]);
		manager.resetBuffers();
		expect(manager.checkDelta("dle", ctx())).toEqual([]);
	});
});

describe("scope and glob gating", () => {
	it("thinking-only rule ignores the text stream", () => {
		const manager = makeManager();
		const scope: TtsrScope = { allowText: false, allowThinking: true, toolScopes: [] };
		manager.addRule(makeRule("think", { scope }));
		expect(manager.checkDelta("needle", ctx({ source: "text" }))).toEqual([]);
		expect(names(manager.checkDelta("needle", ctx({ source: "thinking" })))).toEqual(["think"]);
	});

	it("tool scope matches by tool name and path glob", () => {
		const manager = makeManager();
		const scope: TtsrScope = {
			allowText: false,
			allowThinking: false,
			toolScopes: [{ toolName: "edit", pathGlob: "**/*.ts" }],
		};
		manager.addRule(makeRule("edit-ts", { scope }));
		expect(manager.checkDelta("needle", ctx({ source: "tool", streamKey: "c1", toolName: "bash" }))).toEqual([]);
		expect(
			manager.checkDelta("needle", ctx({ source: "tool", streamKey: "c2", toolName: "edit", filePaths: ["a.py"] })),
		).toEqual([]);
		expect(
			names(
				manager.checkDelta(
					"needle",
					ctx({ source: "tool", streamKey: "c3", toolName: "edit", filePaths: ["src/a.ts"] }),
				),
			),
		).toEqual(["edit-ts"]);
	});

	it("tool-scoped rules match tool streams while text-only rules do not", () => {
		const manager = makeManager();
		manager.addRule(
			makeRule("tool-only", {
				scope: { allowText: false, allowThinking: false, toolScopes: [{ toolName: "bash" }] },
			}),
		);
		manager.addRule(
			makeRule("text-only", {
				scope: { allowText: true, allowThinking: false, toolScopes: [] },
			}),
		);
		expect(
			names(manager.checkDelta("needle", ctx({ source: "tool", streamKey: "tool:0", toolName: "bash" }))),
		).toEqual(["tool-only"]);
		expect(names(manager.checkDelta("needle", ctx({ source: "text", streamKey: "text:0" })))).toEqual(["text-only"]);
	});

	it("wildcard tool scope matches any tool name", () => {
		const manager = makeManager();
		const scope: TtsrScope = { allowText: false, allowThinking: false, toolScopes: [{ toolName: "*" }] };
		manager.addRule(makeRule("any-tool", { scope }));
		expect(names(manager.checkDelta("needle", ctx({ source: "tool", streamKey: "c1", toolName: "bash" })))).toEqual([
			"any-tool",
		]);
	});

	it("rule globs gate matching on context file paths, including basename fallback", () => {
		const manager = makeManager();
		manager.addRule(makeRule("py-only", { globs: ["*.py"] }));
		expect(manager.checkDelta("needle", ctx())).toEqual([]);
		expect(manager.checkDelta("needle", ctx({ streamKey: "b", filePaths: ["src/x.ts"] }))).toEqual([]);
		expect(names(manager.checkDelta("needle", ctx({ streamKey: "c", filePaths: ["src/x.py"] })))).toEqual([
			"py-only",
		]);
	});
});

describe("repeat gating and injected state", () => {
	it("repeatMode once fires exactly once across turns", () => {
		const manager = makeManager();
		manager.addRule(makeRule("once-rule"));
		manager.markInjected(manager.checkDelta("needle", ctx()));
		manager.resetBuffers();
		manager.incrementMessageCount();
		expect(manager.checkDelta("needle", ctx())).toEqual([]);
		manager.resetBuffers();
		manager.incrementMessageCount();
		expect(manager.checkDelta("needle", ctx())).toEqual([]);
	});

	it("after-gap refires only after repeatGap completed turns, not chunks", () => {
		const manager = makeManager({ ...DEFAULT_TTSR_SETTINGS, repeatMode: "after-gap", repeatGap: 2 });
		manager.addRule(makeRule("gap-rule"));
		manager.markInjected(manager.checkDelta("needle", ctx()));
		manager.incrementMessageCount();
		manager.resetBuffers();
		expect(manager.checkDelta("needle", ctx())).toEqual([]);
		expect(manager.checkDelta("needle again", ctx())).toEqual([]);
		manager.incrementMessageCount();
		manager.resetBuffers();
		expect(names(manager.checkDelta("needle", ctx()))).toEqual(["gap-rule"]);
	});

	it("restoreInjected round-trip suppresses once-rules on a fresh manager", () => {
		const source = makeManager();
		source.addRule(makeRule("persisted"));
		source.markInjected(source.checkDelta("needle", ctx()));
		const injected = source.getInjectedRuleNames();
		expect(injected).toEqual(["persisted"]);
		const restored = makeManager();
		restored.addRule(makeRule("persisted"));
		restored.restoreInjected(injected);
		expect(restored.getInjectedRuleNames()).toEqual(["persisted"]);
		expect(restored.checkDelta("needle", ctx())).toEqual([]);
		const plain = makeManager();
		plain.addRule(makeRule("persisted"));
		expect(names(plain.checkDelta("needle", ctx()))).toEqual(["persisted"]);
	});

	it("markInjectedByNames gates a rule before it ever fires", () => {
		const manager = makeManager();
		manager.addRule(makeRule("by-name"));
		manager.markInjectedByNames(["by-name"]);
		expect(manager.checkDelta("needle", ctx())).toEqual([]);
	});
});

describe("introspection", () => {
	it("exposes rules in registration order and the settings it was built with", () => {
		const settings: TtsrSettings = { ...DEFAULT_TTSR_SETTINGS, repeatGap: 3 };
		const manager = makeManager(settings);
		manager.addRule(makeRule("a"));
		manager.addRule(makeRule("b"));
		expect(names(manager.getRules())).toEqual(["a", "b"]);
		expect(manager.hasRules()).toBe(true);
		expect(manager.getSettings()).toEqual(settings);
		expect(manager.getMessageCount()).toBe(0);
	});
});
