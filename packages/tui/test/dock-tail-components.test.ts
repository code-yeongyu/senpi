import assert from "node:assert/strict";
import { it } from "node:test";
import { Box } from "../src/components/box.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Spacer } from "../src/components/spacer.ts";
import type { Component, TailRenderContext, TuiMouseEvent } from "../src/tui.ts";

const context: TailRenderContext = {
	signal: new AbortController().signal,
	revision: 0,
	requestRender() {},
};

function rowsComponent(lines: string[]): Component {
	return {
		invalidate() {},
		render: () => lines,
		renderTail: (_width, maxRows) => {
			const rowOffset = Math.max(0, lines.length - maxRows);
			return { lines: lines.slice(rowOffset), pending: false, hasMore: rowOffset > 0 };
		},
	};
}

it("Box delegates row budgets and preserves padding/background without eager child rendering", () => {
	for (const rows of [1, 2, 4, 9, 20]) {
		const child = rowsComponent(["first", "日本語", "last"]);
		const box = new Box(2, 2, (line) => `\x1b[44m${line}\x1b[0m`);
		box.addChild(child);
		const expected = box.render(16).slice(-rows);
		child.render = () => {
			throw new Error("unexpected eager render");
		};
		const actual = box.renderTail(16, rows, context);
		assert.deepEqual(actual.lines, expected);
		assert.equal(actual.pending, false);
	}
	const hugePadding = new Box(1, 1_000_000);
	hugePadding.addChild(rowsComponent(["body"]));
	assert.deepEqual(hugePadding.renderTail(8, 3, context).lines, ["        ", "        ", "        "]);
});

it("Spacer returns only requested rows and reports earlier rows", () => {
	const spacer = new Spacer(1_000_000);
	assert.deepEqual(spacer.renderTail(20, 3, context), {
		lines: ["", "", ""],
		pending: false,
		hasMore: true,
	});
});

it("MouseRegion delegates bounded suffix rendering and keeps canonical child-first mouse fallback", () => {
	const child = rowsComponent(["first", "second", "third"]);
	child.render = () => {
		throw new Error("unexpected eager render");
	};
	child.handleMouse = () => undefined;
	let fallback = 0;
	const region = new MouseRegion(child, () => {
		fallback++;
		return { handled: true };
	});
	const result = region.renderTail(20, 2, context);
	assert.deepEqual(result.lines, ["second", "third"]);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		clickCount: 1,
		x: 0,
		y: 1,
		screenX: 0,
		screenY: 0,
		width: 20,
		height: 3,
		shift: false,
		alt: false,
		ctrl: false,
	};
	assert.equal(region.handleMouse(event)?.handled, true);
	assert.equal(fallback, 1);
	child.handleMouse = () => ({ handled: true });
	assert.equal(region.handleMouse(event)?.handled, true);
	assert.equal(fallback, 1, "a handled child event suppresses the wrapper fallback");
});
