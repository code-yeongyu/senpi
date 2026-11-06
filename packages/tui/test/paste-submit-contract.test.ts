import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Mirrors ProcessTerminal: StdinBuffer frames stdin, each paste is re-wrapped in bracketed-paste markers,
// each data sequence reaches the editor as one key event.
function createHarness() {
	const submitted: string[] = [];
	const editor = new Editor(new TUI(new VirtualTerminal(120, 30)), defaultEditorTheme);
	editor.onSubmit = (text) => submitted.push(text);
	const buffer = new StdinBuffer({ burstWindowMs: 20, now: () => 1000 });
	buffer.on("data", (sequence) => editor.handleInput(sequence));
	buffer.on("paste", (content) => editor.handleInput(`\x1b[200~${content}\x1b[201~`));
	return {
		submitted,
		editor,
		write(data: string) {
			buffer.process(data);
			buffer.flush();
		},
		destroy() {
			buffer.destroy();
		},
	};
}

const REQUEST = Array.from({ length: 30 }, (_, index) => `line ${index + 1}: follow the instructions above`).join("\n");

describe("paste then Enter submit contract (senpi#3076)", () => {
	it("submits an unbracketed paste whose Enter arrives in the same write", () => {
		const harness = createHarness();
		harness.write(`${REQUEST}\r`);
		assert.deepStrictEqual(harness.submitted, [REQUEST]);
		assert.strictEqual(harness.editor.getText(), "");
		harness.destroy();
	});

	it("submits an unbracketed paste whose Enter arrives in a separate write with no delay", () => {
		const harness = createHarness();
		harness.write(REQUEST);
		harness.write("\r");
		assert.deepStrictEqual(harness.submitted, [REQUEST]);
		assert.strictEqual(harness.editor.getText(), "");
		harness.destroy();
	});

	it("submits a bracketed paste whose Enter arrives in a separate write with no delay", () => {
		const harness = createHarness();
		harness.write(`\x1b[200~${REQUEST}\x1b[201~`);
		harness.write("\r");
		assert.deepStrictEqual(harness.submitted, [REQUEST]);
		assert.strictEqual(harness.editor.getText(), "");
		harness.destroy();
	});

	it("submits a single-line write whose Enter arrives in a separate write with no delay", () => {
		const harness = createHarness();
		harness.write("please review the branch");
		harness.write("\r");
		assert.deepStrictEqual(harness.submitted, ["please review the branch"]);
		harness.destroy();
	});

	it("keeps a bracketed paste that ends with a newline unsubmitted", () => {
		const harness = createHarness();
		harness.write("\x1b[200~first line\nsecond line\x1b[201~");
		assert.deepStrictEqual(harness.submitted, []);
		assert.strictEqual(harness.editor.getText(), "first line\nsecond line");
		harness.destroy();
	});

	it("keeps a CRLF-terminated paste in the paste instead of submitting it", () => {
		const harness = createHarness();
		harness.write("first line\r\nsecond line\r\n");
		assert.deepStrictEqual(harness.submitted, []);
		assert.strictEqual(harness.editor.getText(), "first line\nsecond line\n");
		harness.destroy();
	});
});
