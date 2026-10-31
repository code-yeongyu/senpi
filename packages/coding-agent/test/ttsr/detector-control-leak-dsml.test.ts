import { describe, expect, it } from "vitest";

import { createControlLeakDetector } from "../../src/core/extensions/builtin/ttsr/detectors/control-leak.ts";
import { TtsrManager } from "../../src/core/extensions/builtin/ttsr/manager.ts";
import { compileRuleCondition } from "../../src/core/extensions/builtin/ttsr/rule-condition.ts";
import { DEFAULT_TTSR_SETTINGS, type TtsrStreamSource } from "../../src/core/extensions/builtin/ttsr/types.ts";
import { StreamWatcher } from "../../src/core/extensions/builtin/ttsr/watch.ts";
import { PLAIN_PROSE_PREFIX } from "./control-leak-helpers.ts";

// senpi#4621: DeepSeek special tokens use a fullwidth bar (U+FF5C) and DSML tool-call tags carry attributes.
const WIDE = "\uFF5C";
const SPACE_MARK = "\u2581";
const dsml = (rest: string): string => `<${WIDE}DSML${WIDE}${rest}>`;
const dsmlClose = (rest: string): string => `</${WIDE}DSML${WIDE}${rest}>`;
const wide = (name: string): string => `<${WIDE}${name}${WIDE}>`;
const FENCE = "`".repeat(3);

function firstMatch(source: TtsrStreamSource, text: string, chunkSize: number) {
	const detector = createControlLeakDetector();
	const state = detector.createState();
	for (let index = 0; index < text.length; index += chunkSize) {
		const match = detector.checkDelta(state, text.slice(index, index + chunkSize), {
			source,
			streamKey: "fixture",
			generation: 1,
		});
		if (match !== null) return match;
	}
	return null;
}

describe("control-token-leak recognises DeepSeek DSML and fullwidth special tokens (senpi#4621)", () => {
	it.each([
		{
			name: "a DSML invoke tag in thinking",
			source: "thinking",
			text: `${PLAIN_PROSE_PREFIX} ${dsml(' invoke name="bash"')}`,
		},
		{ name: "a DSML tag with no space", source: "thinking", text: `${PLAIN_PROSE_PREFIX} ${dsml("function_calls")}` },
		{ name: "a closing DSML tag", source: "text", text: `${PLAIN_PROSE_PREFIX} ${dsmlClose(" parameter")}` },
		{ name: "an ASCII-bar DSML tag", source: "text", text: `${PLAIN_PROSE_PREFIX} <|DSML|invoke name="x">` },
		{
			name: "a run of fullwidth end-of-sentence tokens",
			source: "text",
			text: `${PLAIN_PROSE_PREFIX} ${Array(4)
				.fill(wide(`end${SPACE_MARK}of${SPACE_MARK}sentence`))
				.join(" ")}`,
		},
	] as const)("flags $name", ({ source, text }) => {
		for (const chunkSize of [1, 3, 7, text.length]) {
			expect(firstMatch(source, text, chunkSize)?.rule, `chunk ${chunkSize}`).toBe("control-token-leak");
		}
	});

	it.each([
		{
			name: "DSML quoted inside a code fence",
			text: `Example:\n${FENCE}\n${dsml(' invoke name="bash"')}\n${FENCE}\n`,
		},
		{ name: "a single fullwidth token in prose", text: `${PLAIN_PROSE_PREFIX} ${wide("User")} said hello.` },
		{ name: "fullwidth bars in plain prose", text: `${PLAIN_PROSE_PREFIX} a ${WIDE} b ${WIDE} c < d` },
	])("does not flag $name", ({ text }) => {
		expect(firstMatch("text", text, 5)).toBeNull();
	});

	it("does not flag DSML quoted in a tool argument, where a file being written may legitimately hold it", () => {
		expect(firstMatch("tool", `{"content":"${dsml(' invoke name="bash"')}"}`, 5)).toBeNull();
	});

	it("resolves a looping DSML imitation in thinking to a resample, not a collapse correction", () => {
		const manager = new TtsrManager(DEFAULT_TTSR_SETTINGS, (pattern) => compileRuleCondition(pattern).regex);
		const watcher = new StreamWatcher(manager, []);
		const loop = Array.from(
			{ length: 12 },
			(_, index) =>
				`${dsml(' invoke name="bash"')}\n${dsml(' parameter name="command" string="true"')}echo done${27 + index}${dsmlClose(" parameter")}\n${dsmlClose(" invoke")}\n`,
		).join("");
		const stream = `Let me check the build output first.\n${loop}`;
		let resolution = null;
		for (let index = 0; index < stream.length && resolution === null; index += 9) {
			resolution = watcher.handleDelta("thinking", "thinking:0", stream.slice(index, index + 9), 1).resolution;
		}
		expect(resolution?.owner).toBe("control-token-leak");
		expect(resolution?.remediation.retryMode).toBe("provider-error");
	});
});
