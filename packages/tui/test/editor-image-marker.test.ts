import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const UNDO = "\x1b[45;5u"; // Ctrl+-
const BACKSPACE = "\x7f";
const FORWARD_DELETE = "\x1b[3~";
const ALT_LEFT = "\x1bb";
const ALT_RIGHT = "\x1bf";
const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const LINE_START = "\x01"; // Ctrl+A
const LINE_END = "\x05"; // Ctrl+E

function createEditor(width = 120): Editor {
	return new Editor(new TUI(new VirtualTerminal(width, 30)), defaultEditorTheme);
}

function type(editor: Editor, text: string): void {
	for (const char of text) editor.handleInput(char);
}

function trackOrders(editor: Editor): number[][] {
	const orders: number[][] = [];
	editor.onImageMarkersChanged = (order) => {
		orders.push([...order]);
	};
	return orders;
}

describe("editor image markers", () => {
	it("inserts canonical markers at the cursor and returns increasing ids", () => {
		const editor = createEditor();
		type(editor, "look at ");

		assert.strictEqual(editor.insertImageMarker(), 1);
		assert.strictEqual(editor.getText(), "look at [Image #1]");

		type(editor, " and ");
		assert.strictEqual(editor.insertImageMarker(), 2);
		assert.strictEqual(editor.getText(), "look at [Image #1] and [Image #2]");
	});

	it("reports the marker order whenever markers change", () => {
		const editor = createEditor();
		const orders = trackOrders(editor);

		editor.insertImageMarker();
		editor.insertImageMarker();

		assert.deepStrictEqual(orders, [[1], [1, 2]]);
	});

	it("renumbers the visible markers when one is inserted before existing ones", () => {
		const editor = createEditor();
		editor.insertImageMarker();
		editor.handleInput(LINE_START);
		const orders = trackOrders(editor);

		const id = editor.insertImageMarker();

		// The visible numbers must stay canonical 1..k in reading order, and the
		// returned id must be the FINAL number: the owner registers its payload
		// under that id, so returning the insertion counter here mispairs every
		// attachment after an out-of-order insert. The notification carries the
		// PRE-renumber ids (id 2 inserted in front of id 1) - the keys the owner's
		// payloads currently sit under - matching removeImageMarker's survivor
		// contract.
		assert.strictEqual(editor.getText(), "[Image #1][Image #2]");
		assert.strictEqual(id, 1);
		assert.deepStrictEqual(orders, [[2, 1]]);
	});

	it("canonicalizes the numbering after a setText prune leaves a gap", () => {
		const editor = createEditor();
		editor.insertImageMarker();
		editor.insertImageMarker();
		const orders = trackOrders(editor);

		editor.setText("tail [Image #2]");

		// Only id 2 survived the prune; it must display as [Image #1] so the
		// Nth marker in reading order still equals the Nth submitted image.
		assert.strictEqual(editor.getText(), "tail [Image #1]");
		assert.deepStrictEqual(orders.at(-1), [2]);
	});

	it("restores the owner's attachment payloads when undoing a marker delete", () => {
		const editor = createEditor();
		const payloads = new Map<number, string>();
		const restored: Map<number, string>[] = [];
		editor.snapshotAttachmentState = () => new Map(payloads);
		editor.restoreAttachmentState = (state) => {
			restored.push(state as Map<number, string>);
		};

		editor.insertImageMarker();
		payloads.set(1, "A");
		editor.insertImageMarker();
		payloads.set(2, "B");
		editor.insertImageMarker();
		payloads.set(3, "C");
		editor.handleInput(ARROW_LEFT);
		editor.handleInput(BACKSPACE);
		assert.strictEqual(editor.getText(), "[Image #1][Image #2]");

		editor.handleInput(UNDO);

		// The editor's undo restores marker text and registry ids; the PAYLOADS
		// live with the owner, so undo must hand the captured snapshot back
		// BEFORE the marker-order notification fires, or the delete's re-keying
		// permanently destroys the middle image.
		assert.strictEqual(editor.getText(), "[Image #1][Image #2][Image #3]");
		const last = restored.at(-1);
		assert.ok(last);
		assert.deepStrictEqual(
			[...last.entries()],
			[
				[1, "A"],
				[2, "B"],
				[3, "C"],
			],
		);
	});

	it("deletes the whole marker with a single backspace", () => {
		const editor = createEditor();
		type(editor, "a ");
		editor.insertImageMarker();
		const orders = trackOrders(editor);

		editor.handleInput(BACKSPACE);

		assert.strictEqual(editor.getText(), "a ");
		assert.deepStrictEqual(orders, [[]]);
		assert.deepStrictEqual(editor.getImageMarkerState().ids, []);
	});

	it("deletes the whole marker with forward delete and drops the registry entry", () => {
		const editor = createEditor();
		editor.insertImageMarker();
		type(editor, " tail");
		editor.handleInput(LINE_START);
		const orders = trackOrders(editor);

		editor.handleInput(FORWARD_DELETE);

		assert.strictEqual(editor.getText(), " tail");
		assert.deepStrictEqual(orders, [[]]);
		assert.deepStrictEqual(editor.getImageMarkerState().ids, []);
	});

	it("renumbers the survivor when an earlier marker is deleted", () => {
		const editor = createEditor();
		editor.insertImageMarker();
		type(editor, " ");
		editor.insertImageMarker();
		editor.handleInput(LINE_START);
		const orders = trackOrders(editor);

		editor.handleInput(FORWARD_DELETE);

		assert.strictEqual(editor.getText(), " [Image #1]");
		assert.deepStrictEqual(orders, [[2]]);
		assert.deepStrictEqual(editor.getImageMarkerState().ids, [1]);
	});

	it("renumbers the survivor when a later marker is backspaced", () => {
		const editor = createEditor();
		editor.insertImageMarker();
		type(editor, " ");
		editor.insertImageMarker();
		const orders = trackOrders(editor);

		editor.handleInput(BACKSPACE);

		assert.strictEqual(editor.getText(), "[Image #1] ");
		assert.deepStrictEqual(orders, [[1]]);
	});

	it("crosses the marker as one unit for alt+left / alt+right word navigation", () => {
		const editor = createEditor();
		type(editor, "aa ");
		editor.insertImageMarker();
		type(editor, " bb");

		// "aa [Image #1] bb": marker occupies columns 3..13, "bb" starts at 14.
		assert.strictEqual(editor.getText(), "aa [Image #1] bb");

		editor.handleInput(LINE_END);
		editor.handleInput(ALT_LEFT); // to start of "bb"
		assert.strictEqual(editor.getCursor().col, 14);
		editor.handleInput(ALT_LEFT); // across the whole marker in one jump
		assert.strictEqual(editor.getCursor().col, 3);

		editor.handleInput(ALT_RIGHT); // back across the whole marker in one jump
		assert.strictEqual(editor.getCursor().col, 13);
	});

	it("traverses the marker as one unit with left/right arrows", () => {
		const editor = createEditor();
		editor.insertImageMarker();
		assert.strictEqual(editor.getCursor().col, 10);

		editor.handleInput(ARROW_LEFT);
		assert.strictEqual(editor.getCursor().col, 0);

		editor.handleInput(ARROW_RIGHT);
		assert.strictEqual(editor.getCursor().col, 10);
	});

	it("wraps the marker as one atomic segment and never breaks at its inner space", () => {
		const width = 14; // 13 usable columns + 1 reserved for the cursor
		const editor = createEditor(width);
		type(editor, "ab ");
		editor.insertImageMarker();
		type(editor, " cd");
		assert.strictEqual(editor.getText(), "ab [Image #1] cd");

		const contentLines = editor
			.render(width)
			.slice(1, -1)
			.map((line) => stripVTControlCharacters(line).trimEnd());

		// The whitespace hazard: /\s/.test("[Image #1]") is true, so a marker treated
		// as whitespace would break as ["ab [Image", "#1] cd"].
		assert.deepStrictEqual(contentLines, ["ab", "[Image #1] cd"]);
	});

	it("wraps the marker onto its own visual line when it does not fit", () => {
		const width = 11; // 10 usable columns + 1 reserved for the cursor
		const editor = createEditor(width);
		type(editor, "ab ");
		editor.insertImageMarker();
		type(editor, " cd");

		const contentLines = editor
			.render(width)
			.slice(1, -1)
			.map((line) => stripVTControlCharacters(line).trimEnd());

		assert.deepStrictEqual(contentLines, ["ab", "[Image #1]", " cd"]);
	});

	it("restores marker text and registry entry when undoing a delete", () => {
		const editor = createEditor();
		editor.insertImageMarker();
		editor.handleInput(BACKSPACE);
		assert.strictEqual(editor.getText(), "");
		const orders = trackOrders(editor);

		editor.handleInput(UNDO);

		assert.strictEqual(editor.getText(), "[Image #1]");
		assert.deepStrictEqual(editor.getImageMarkerState().ids, [1]);
		assert.deepStrictEqual(orders, [[1]]);
	});

	it("drops the registry entry when undoing an insert", () => {
		const editor = createEditor();
		type(editor, "hi");
		editor.insertImageMarker();
		const orders = trackOrders(editor);

		editor.handleInput(UNDO);

		assert.strictEqual(editor.getText(), "hi");
		assert.deepStrictEqual(editor.getImageMarkerState().ids, []);
		assert.deepStrictEqual(orders, [[]]);
	});

	it("never expands an image marker in getExpandedText", () => {
		const editor = createEditor();
		type(editor, "see ");
		editor.insertImageMarker();

		assert.strictEqual(editor.getExpandedText(), "see [Image #1]");
	});

	it("prunes markers absent from setText and reports an empty order", () => {
		const editor = createEditor();
		editor.insertImageMarker();
		const orders = trackOrders(editor);

		editor.setText("plain text");

		assert.deepStrictEqual(editor.getImageMarkerState().ids, []);
		assert.deepStrictEqual(orders.at(-1), []);
	});

	it("keeps markers that survive setText", () => {
		const editor = createEditor();
		editor.insertImageMarker();

		editor.setText("kept [Image #1]");

		assert.deepStrictEqual(editor.getImageMarkerState().ids, [1]);
	});

	it("round-trips image marker state across editor instances", () => {
		const source = createEditor();
		source.insertImageMarker();
		type(source, " x ");
		source.insertImageMarker();

		const target = createEditor();
		target.setText(source.getText());
		target.setImageMarkerState(source.getImageMarkerState());

		assert.deepStrictEqual(target.getImageMarkerState().ids, [1, 2]);
		target.handleInput(BACKSPACE);
		assert.strictEqual(target.getText(), "[Image #1] x ");
		assert.deepStrictEqual(target.getImageMarkerState().ids, [1]);
	});

	it("keeps paste markers working alongside image markers", () => {
		const editor = createEditor();
		const body = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
		editor.handleInput(`\x1b[200~${body}\x1b[201~`);
		const pasteMarker = editor.getText();
		editor.insertImageMarker();

		assert.strictEqual(editor.getText(), `${pasteMarker}[Image #1]`);
		assert.strictEqual(editor.getExpandedText(), `${body}[Image #1]`);

		editor.handleInput(BACKSPACE);
		assert.strictEqual(editor.getText(), pasteMarker);
		editor.handleInput(BACKSPACE);
		assert.strictEqual(editor.getText(), "");
	});
});
