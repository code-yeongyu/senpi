import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { wrapTextWithAnsi } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CursorTerminal extends VirtualTerminal {
	queries = 0;
	lastQuery?: Promise<{ row: number; column: number }>;
	queryCursorPosition() {
		this.queries++;
		this.lastQuery = this.flush().then(() => {
			const position = this.getCursorPosition();
			return { row: position.y + 1, column: position.x + 1 };
		});
		return this.lastQuery;
	}
}

function fixture(renderHistory: (width: number) => string[]) {
	const terminal = new CursorTerminal(80, 8);
	const renderer = new TuiMainScreen(terminal);
	renderer.setClearOnShrink(false);
	let fullRenders = 0;
	const history: Component = {
		render: (width) => {
			fullRenders++;
			return renderHistory(width);
		},
		invalidate() {},
	};
	const controls = (width: number) => [`border ${width}`, `${CURSOR_MARKER}input`, "footer"];
	renderer.addChild(history);
	renderer.addChild({
		render: controls,
		renderTail: (width) => ({ lines: controls(width), pending: false, hasMore: false }),
		invalidate() {},
	});
	renderer.setWorkingRegionAfter(history, () => 1);
	const resize = async (width: number, height = 8) => {
		const queries = terminal.queries;
		terminal.resize(width, height);
		renderer.renderNow();
		if (terminal.queries > queries) {
			await terminal.lastQuery;
			renderer.renderNow();
		}
		await terminal.flush();
	};
	return { terminal, renderer, resize, fullRenders: () => fullRenders };
}

describe("native working-region first adoption", () => {
	it("reflows a fitting canonical frame immediately without a cursor query", async () => {
		const f = fixture(() => ["one", "two", "three"]);
		try {
			f.renderer.renderNow();
			await f.terminal.flush();
			await f.resize(40);
			assert.equal(f.terminal.queries, 0);
			assert.equal(f.fullRenders(), 2);
			assert.ok(f.terminal.getViewport().includes("border 40"));
			assert.ok(f.terminal.getViewport().includes("input"));
		} finally {
			f.renderer.stop();
		}
	});

	it("canonically wraps fitting CJK content into overflow once, then preserves native history", async () => {
		const source = Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
		const f = fixture((width) => wrapTextWithAnsi(source, width));
		try {
			f.renderer.renderNow();
			await f.terminal.flush();
			assert.equal(f.renderer.captureRenderState().previousLines.length, 8);
			await f.resize(20);
			assert.equal(f.terminal.queries, 0);
			assert.equal(f.fullRenders(), 2);
			assert.ok(f.renderer.captureRenderState().previousLines.length > 8);
			await f.resize(40);
			assert.equal(f.terminal.queries, 1);
			assert.equal(f.fullRenders(), 2);
			const committed = f.terminal.getScrollBuffer().join("");
			for (const character of source) assert.equal(committed.split(character).length - 1, 1);
			assert.deepEqual(f.terminal.getViewport().slice(-3), ["border 40", "input", "footer"]);
		} finally {
			f.renderer.stop();
		}
	});

	it("keeps prior overflow eligible even after its canonical content shrinks", async () => {
		let rows = 20;
		const f = fixture(() => Array.from({ length: rows }, (_, i) => `history ${i}`));
		try {
			f.renderer.renderNow();
			await f.terminal.flush();
			rows = 2;
			f.renderer.renderNow();
			await f.terminal.flush();
			const state = f.renderer.captureRenderState();
			assert.ok(state.previousLines.length <= 8);
			const rendered = f.fullRenders();
			await f.resize(40);
			assert.equal(f.terminal.queries, 1);
			assert.equal(f.fullRenders(), rendered);
		} finally {
			f.renderer.stop();
		}
	});

	it("does not mistake an adopted native dock for a fitting complete document", async () => {
		const f = fixture(() => Array.from({ length: 20 }, (_, i) => `history ${i}`));
		try {
			f.renderer.renderNow();
			await f.terminal.flush();
			await f.resize(40);
			assert.equal(f.renderer.captureRenderState().previousLines.length, 3);
			await f.resize(60, 40);
			assert.equal(f.terminal.queries, 2);
			assert.equal(f.fullRenders(), 1);
		} finally {
			f.renderer.stop();
		}
	});
});
