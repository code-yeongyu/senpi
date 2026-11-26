import { describe, expect, it } from "vitest";
import { TtsrManager } from "../../src/core/extensions/builtin/ttsr/manager.ts";
import { DEFAULT_TTSR_SETTINGS } from "../../src/core/extensions/builtin/ttsr/types.ts";
import { StreamWatcher } from "../../src/core/extensions/builtin/ttsr/watch.ts";

// omo#10789: the control-token-leak guard aborted show_html_page because a tool-argument stream
// (raw JSON) with 4+ consecutive closing tags like </div></div></div></div> latched the detector.
// A tool call's arguments are structured data the tool validates, not a channel where a leaked chat
// control token means anything, so the leak detector must not run on `source: "tool"`.
function watcher(): StreamWatcher {
	return new StreamWatcher(new TtsrManager(DEFAULT_TTSR_SETTINGS, () => null), []);
}

const HTML = `{"title":"t","html":"<!doctype html><body><div><div><div><div>x</div></div></div></div></body>"}`;

describe("control-token-leak and tool arguments (omo#10789)", () => {
	it("does not fire on an HTML tool argument with consecutive closing tags", () => {
		const watch = watcher();
		let fired = false;
		for (let i = 0; i < HTML.length; i += 7) {
			const outcome = watch.handleDelta("tool", "show_html_page:1", HTML.slice(i, i + 7), 1, "show_html_page");
			if (outcome.resolution !== null) fired = true;
		}
		expect(fired).toBe(false);
	});

	// The grammar alone stays silent on </div>, so this case owns the source bypass: </s> is a
	// tokenizer special token AND HTML strikethrough, and a tool argument must still never fire.
	it("does not fire on a tool argument whose markup spells a tokenizer special token", () => {
		const watch = watcher();
		const html = `{"html":"<s><s><s><s>old</s></s></s></s>"}`;
		let fired = false;
		for (let i = 0; i < html.length; i += 7) {
			const outcome = watch.handleDelta("tool", "show_html_page:1", html.slice(i, i + 7), 1, "show_html_page");
			if (outcome.resolution !== null) fired = true;
		}
		expect(fired).toBe(false);
	});

	// A degenerate run of chat-template controls inside a tool argument would be written to disk
	// by the tool, so only angle-bracket markup is exempt in tool arguments (#3875 review).
	it("still fires on a run of chat-template control tokens in a tool argument", () => {
		const watch = watcher();
		const args = `{"path":"a.txt","content":"done ${"<|im_end|>".repeat(6)}"}`;
		let fired = false;
		for (let i = 0; i < args.length; i += 7) {
			const outcome = watch.handleDelta("tool", "write:1", args.slice(i, i + 7), 1, "write");
			if (outcome.resolution !== null) fired = true;
		}
		expect(fired).toBe(true);
	});

	it("still fires on genuine control-token leakage in assistant text", () => {
		const watch = watcher();
		const leak = "answer: " + "</s>".repeat(6);
		let fired = false;
		for (let i = 0; i < leak.length; i += 3) {
			const outcome = watch.handleDelta("text", "assistant:1", leak.slice(i, i + 3), 1);
			if (outcome.resolution !== null) fired = true;
		}
		expect(fired).toBe(true);
	});
});

describe("control-token-leak and ordinary markup in prose (omo#10789)", () => {
	const feed = (text: string, source: "text" | "thinking"): boolean => {
		const watch = watcher();
		let fired = false;
		for (let i = 0; i < text.length; i += 5) {
			const outcome = watch.handleDelta(source, `${source}:1`, text.slice(i, i + 5), 1);
			if (outcome.resolution !== null) fired = true;
		}
		return fired;
	};

	it("does not fire on consecutive HTML closing tags in assistant prose", () => {
		const closers = "</div>".repeat(4);
		expect(feed(`The page ends with ${closers} and then the body closes.`, "text")).toBe(false);
	});

	it("does not fire on a long run of nested closing tags in thinking", () => {
		expect(feed(`nested markup: ${"</section>".repeat(10)}`, "thinking")).toBe(false);
	});

	it("still fires on a leaked tokenizer special token in prose", () => {
		expect(feed(`answer: ${"</s>".repeat(6)}`, "text")).toBe(true);
	});

	it("still fires on a leaked turn marker regardless of case", () => {
		expect(feed(`done ${"<END_OF_TURN>".repeat(6)}`, "text")).toBe(true);
	});
});
