import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getLayoutBoxesAt, getScrollbarGeometry, getScrollViewBox, renderLayoutFrame } from "../src/layout.ts";
import type { ScrollEntry, ScrollEntrySource } from "../src/layout-node.ts";
import { cropKittyImageLine, encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function fixture(count: number, makeLines: (index: number, width: number) => string[] = (index) => [`entry ${index}`]) {
	const calls = new Map<number, number>();
	const entries: ScrollEntry[] = Array.from({ length: count }, (_, index) => ({
		key: {},
		sourceIndex: index,
		revision: 0,
		component: {
			render(width: number) {
				calls.set(index, (calls.get(index) ?? 0) + 1);
				return makeLines(index, width);
			},
			invalidate() {},
		},
	}));
	const source: ScrollEntrySource = {
		version: 0,
		displayRevision: 0,
		get length() {
			return entries.length;
		},
		get: (index) => entries[index]!,
		indexOf: (key) => {
			const index = entries.findIndex((entry) => entry.key === key);
			return index < 0 ? undefined : index;
		},
		resolve(key, hint) {
			return this.indexOf(key) ?? Math.max(0, Math.min(entries.length - 1, hint));
		},
	};
	const opaque: Component = {
		render() {
			throw new Error("whole transcript rendered");
		},
		invalidate() {},
	};
	const view = new ScrollView(opaque, { entries: source, follow: "end", primary: true });
	let requested = 0;
	const render = (width = 30, height = 4) =>
		renderLayoutFrame(view, width, height, () => {
			requested++;
		});
	return { source, entries, calls, view, render, requests: () => requested };
}

describe("entry-backed ScrollView", () => {
	it("renders only entries needed by the visible tail and leaves the owning document untouched", () => {
		const { render, calls } = fixture(5_000);
		const frame = render();
		assert.deepEqual(frame.lines, ["entry 4996", "entry 4997", "entry 4998", "entry 4999"]);
		assert.equal(calls.size, 4);
		assert.equal(frame.root.scrollContentLines, undefined);
		assert.equal(frame.root.entryFrame?.rows.length, 4);
	});

	it("reflows visible entries at a new width without measuring the historical head", () => {
		const { render, calls } = fixture(1_000, (index, width) => [`${index}:${width}`, `row ${index}`]);
		render(30, 4);
		calls.clear();
		assert.deepEqual(render(15, 4).lines, ["998:15", "row 998", "999:15", "row 999"]);
		assert.deepEqual(
			[...calls.keys()].sort((a, b) => a - b),
			[998, 999],
		);
	});

	it("scrolls by rows across entry boundaries and follows the end again", () => {
		const { render, view } = fixture(6, (index) => [`${index}a`, `${index}b`]);
		render();
		assert.equal(view.scrollBy(-3), 0);
		assert.deepEqual(render().lines, ["2b", "3a", "3b", "4a"]);
		assert.equal(view.isFollowingEnd, false);
		view.scrollToEnd();
		assert.deepEqual(render().lines, ["4a", "4b", "5a", "5b"]);
		assert.equal(view.isFollowingEnd, true);
	});

	it("keeps the same source anchor while earlier entries are inserted", () => {
		const { render, view, entries, source } = fixture(20);
		view.scrollToAnchor({ key: entries[8]!.key, sourceIndex: 8, row: 0 });
		assert.deepEqual(render().lines, ["entry 8", "entry 9", "entry 10", "entry 11"]);
		entries.unshift({ key: {}, sourceIndex: 0, component: new Text("new earlier row", 0, 0), revision: 0 });
		Object.assign(source, { version: 1 });
		assert.deepEqual(render().lines, ["entry 8", "entry 9", "entry 10", "entry 11"]);
	});

	it("continues through long empty-entry runs without restarting or scanning the whole source in one frame", () => {
		const { render, calls, requests } = fixture(250, (index) => (index === 0 ? ["only row"] : []));
		let frame = render();
		assert.equal(frame.root.entryFrame?.pending, true);
		assert.ok(calls.size <= 64);
		for (let count = 0; count < 10 && frame.root.entryFrame?.pending; count++) frame = render();
		assert.equal(frame.root.entryFrame?.pending, false);
		assert.deepEqual(frame.lines, ["only row", "", "", ""]);
		assert.ok(requests() > 0);
	});

	it("uses bounded intrinsic sizing for indexed auto-basis stacks", () => {
		const { view, calls } = fixture(1_000);
		const frame = renderLayoutFrame(new VStack([view, new Text("dock", 0, 0)]), 20, 5, () => {});
		assert.equal(getScrollViewBox(frame, view)?.rect.height, 1);
		assert.ok(calls.size <= 1);
	});

	it("copies mutable renderer arrays and limits retained entry render count", () => {
		const shared = ["original"];
		const { view, calls } = fixture(70, () => shared);
		const first = view.renderEntry(0, 20);
		shared[0] = "mutated";
		assert.equal(first.lines[0], "original");
		for (let index = 1; index < 70; index++) view.renderEntry(index, 20);
		view.renderEntry(0, 20);
		assert.equal(calls.get(0), 2);
	});

	it("contains indexed overscroll and rejects an explicitly chained indexed view", () => {
		const { source, view } = fixture(1);
		assert.equal(view.overscroll, "contain");
		assert.throws(() => new ScrollView(new Text("unused"), { entries: source, overscroll: "chain" }), /contain/);
	});
	it("reuses a settled window without rescanning a long empty suffix", () => {
		const { render, calls, view } = fixture(250, (index) => (index === 0 ? ["only row"] : []));
		let frame = render();
		for (let i = 0; i < 12 && frame.root.entryFrame?.pending; i++) frame = render();
		assert.equal(frame.root.entryFrame?.pending, false);
		assert.equal(view.isFollowingEnd, true);
		calls.clear();
		assert.deepEqual(render().lines, ["only row", "", "", ""]);
		assert.ok(calls.size <= 1);
		assert.ok([...calls.keys()].every((index) => index === 0));
		assert.equal(view.getEntryScrollbar()?.extent, 1);
	});

	it("yields after the time budget and completes at least one costly entry each frame", (t) => {
		let now = 0;
		t.mock.method(performance, "now", () => now);
		const { render, calls } = fixture(5, (index) => {
			now += 10;
			return [`entry ${index}`];
		});
		let frame = render();
		assert.equal(frame.root.entryFrame?.pending, true);
		assert.equal(calls.size, 1);
		for (let i = 0; i < 12 && frame.root.entryFrame?.pending; i++) frame = render();
		assert.equal(frame.root.entryFrame?.pending, false);
		assert.deepEqual(frame.lines, ["entry 1", "entry 2", "entry 3", "entry 4"]);
	});

	it("cancels pending work on width/source changes and disposal", () => {
		const { render, source, calls, view, requests } = fixture(300, (index, width) =>
			index === 0 ? [`${index}:${width}`] : [],
		);
		assert.equal(render().root.entryFrame?.pending, true);
		Object.assign(source, { version: 1 });
		let frame = render(17);
		assert.equal(frame.root.entryFrame?.version, 1);
		for (let i = 0; i < 15 && frame.root.entryFrame?.pending; i++) frame = render(17);
		assert.deepEqual(frame.lines, ["0:17", "", "", ""]);
		view.scrollToEnd();
		render();
		const beforeCalls = [...calls.values()].reduce((a, b) => a + b, 0);
		view.dispose();
		const beforeRequests = requests();
		render();
		assert.equal(
			[...calls.values()].reduce((a, b) => a + b, 0),
			beforeCalls,
		);
		assert.equal(requests(), beforeRequests);
	});

	it("refreshes unversioned visible entries once per frame and reflows changed heights", () => {
		let text = "before";
		const { render, entries, calls } = fixture(4, (index) => (index === 3 ? text.split("\n") : [`${index}`]));
		entries[3] = { ...entries[3]!, revision: undefined };
		assert.deepEqual(render().lines, ["0", "1", "2", "before"]);
		assert.equal(calls.get(3), 1);
		text = "after";
		assert.deepEqual(render().lines, ["0", "1", "2", "after"]);
		assert.equal(calls.get(3), 2);
		text = "new\nrows";
		assert.deepEqual(render().lines, ["1", "2", "new", "rows"]);
		assert.equal(calls.get(3), 3);
	});

	it("does not publish a mixed source generation from a mutating renderer", () => {
		let change = true;
		const f = fixture(4, (index) => {
			if (change) {
				change = false;
				Object.assign(f.source, { version: 1 });
			}
			return [`${index}`];
		});
		const pending = f.render();
		assert.equal(pending.root.entryFrame?.pending, true);
		assert.equal(pending.root.entryFrame?.entries.length, 0);
		const ready = f.render();
		assert.equal(ready.root.entryFrame?.version, 1);
		assert.deepEqual(ready.lines, ["0", "1", "2", "3"]);
	});

	it("retains no oversized entry in the bounded render cache", () => {
		const { view, calls } = fixture(1, () => ["x".repeat(5 * 1024 * 1024)]);
		view.renderEntry(0, 20);
		view.renderEntry(0, 20);
		assert.equal(calls.get(0), 2);
	});

	it("exposes clipped entry identity and never invokes owning-container mouse traversal", () => {
		const { view, render, entries } = fixture(4, (index) => [`${index}a`, `${index}b`, `${index}c`]);
		view.scrollToAnchor({ key: entries[1]!.key, sourceIndex: 1, row: 1 }, { disableFollow: true });
		const frame = render();
		const hit = getLayoutBoxesAt(frame, 0, 0)[0]!;
		assert.equal(hit.component, entries[1]!.component);
		assert.equal(hit.rect.y, -1);
		assert.equal(hit.rect.height, 3);
		assert.equal(hit.clip.y, 0);
		assert.equal(
			view.handleMouse({
				type: "click",
				x: 0,
				y: 0,
				width: 30,
				height: 4,
				button: "left",
				screenX: 0,
				screenY: 0,
				shift: false,
				alt: false,
				ctrl: false,
			}),
			undefined,
		);
	});

	it("restores a top-clipped Kitty image from the admitted entry only", () => {
		const imageId = 981;
		const image = encodeKitty("AAAA", { columns: 2, rows: 4, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 4, widthPx: 100, heightPx: 100 });
		const { view, render, entries } = fixture(4, (index) =>
			index === 1 ? [image, "", "", "", "after"] : [`entry${index}`],
		);
		view.scrollToAnchor({ key: entries[1]!.key, sourceIndex: 1, row: 1 });
		const frame = render(20, 2);
		assert.equal(frame.lines[0], cropKittyImageLine(image, 1, 2));
	});

	it("uses normalized entry scrollbar positions independently of legacy row geometry", () => {
		const { view, render } = fixture(100);
		view.setScrollbar("always");
		let frame = render();
		assert.equal(view.getEntryScrollbar()?.position, 1);
		assert.equal(getScrollbarGeometry(frame.root)?.maxScrollTop, 1);
		view.scrollToEntryFraction(0);
		frame = render();
		assert.equal(view.getEntryScrollbar()?.position, 0);
		assert.equal(frame.root.entryFrame?.rows[0]?.anchor.sourceIndex, 0);
		view.scrollToEntryFraction(1);
		frame = render();
		assert.equal(frame.root.entryFrame?.rows[0]?.anchor.sourceIndex, 96);
	});
	it("continues browsing an unchanged empty prefix while unrelated tail updates arrive", () => {
		const f = fixture(250, (index) => (index === 200 ? ["visible"] : []));
		Object.assign(f.source, { changedSince: () => 250 });
		f.view.scrollToStart();
		let frame = f.render();
		assert.equal(frame.root.entryFrame?.pending, true);
		for (let i = 1; i < 12 && frame.root.entryFrame?.pending; i++) {
			f.entries.push({
				key: {},
				sourceIndex: f.entries.length,
				revision: 0,
				component: { render: () => [], invalidate() {} },
			});
			Object.assign(f.source, { version: i });
			frame = f.render();
		}
		assert.equal(frame.root.entryFrame?.pending, false);
		assert.deepEqual(frame.lines, ["visible", "", "", ""]);
	});
	it("round-trips the scrollbar midpoint inside a single long entry", () => {
		const { view, render } = fixture(1, () => Array.from({ length: 100 }, (_, row) => `row${row}`));
		render(30, 20);
		view.scrollToEntryFraction(0.5);
		const frame = render(30, 20);
		assert.equal(frame.root.entryFrame?.rows[0]?.anchor.row, 40);
		assert.equal(view.getEntryScrollbar()?.position, 0.5);
		assert.ok(Math.abs(view.getEntryScrollbar()!.extent - 0.2) < 1e-10);
	});

	it("observes empty unversioned tail and intervening entries when they gain rows", () => {
		let middle = "";
		let tail = "";
		const f = fixture(3, (index) =>
			index === 0 ? ["stable"] : (index === 1 ? middle : tail).split("\n").filter(Boolean),
		);
		f.entries[1] = { ...f.entries[1]!, revision: undefined };
		f.entries[2] = { ...f.entries[2]!, revision: undefined };
		assert.deepEqual(f.render().lines, ["stable", "", "", ""]);
		tail = "tail";
		assert.deepEqual(f.render().lines, ["stable", "tail", "", ""]);
		middle = "middle";
		assert.deepEqual(f.render().lines, ["stable", "middle", "tail", ""]);
	});

	it("keeps the committed viewport while rechecking more than64 dynamic empties", () => {
		const f = fixture(100, (index) => (index === 0 ? ["stable"] : []));
		for (let i = 1; i < f.entries.length; i++) f.entries[i] = { ...f.entries[i]!, revision: undefined };
		let frame = f.render();
		for (let i = 0; i < 10 && frame.root.entryFrame?.pending; i++) frame = f.render();
		assert.equal(frame.root.entryFrame?.pending, false);
		assert.deepEqual(frame.lines, ["stable", "", "", ""]);
		const pending = f.render();
		assert.equal(pending.root.entryFrame?.pending, true);
		assert.deepEqual(pending.lines, ["stable", "", "", ""]);
	});

	it("does not cache old output under a display revision changed during render", () => {
		let first = true;
		const f = fixture(1, () => {
			if (first) {
				first = false;
				Object.assign(f.source, { displayRevision: 1 });
				return ["old"];
			}
			return ["new"];
		});
		assert.equal(f.render().root.entryFrame?.pending, true);
		assert.deepEqual(f.render().lines, ["new", "", "", ""]);
		assert.equal(f.calls.get(0), 2);
	});

	it("drops removed entry cache references on source clear and reuses only current entries", () => {
		const f = fixture(4);
		f.render();
		f.entries.length = 0;
		Object.assign(f.source, { version: 1 });
		const frame = f.render();
		assert.deepEqual(frame.lines, ["", "", "", ""]);
		assert.equal(frame.root.entryFrame?.entries.length, 0);
		// This assertion checks bounded-cache ownership, not renderer output mirroring.
		assert.equal(Reflect.get(f.view, "entryCache").size, 0);
	});

	it("contains viewport render errors, logs once, and retries a revisioned entry after recovery", async () => {
		const directory = mkdtempSync(join(tmpdir(), "senpi-indexed-error-"));
		const terminal = new VirtualTerminal(50, 4);
		const tui = new TuiAltScreen(terminal, false, directory);
		let failing = true;
		class RecoveringIndexedComponent {
			render() {
				if (failing) throw new Error("expected test failure");
				return ["recovered"];
			}
			invalidate() {}
		}
		const f = fixture(1);
		f.entries[0] = { ...f.entries[0]!, component: new RecoveringIndexedComponent() };
		tui.setLayoutRoot(f.view);
		try {
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[0]!.includes("[render error: RecoveringIndexedComponent]"));
			assert.throws(() => f.view.renderEntry(0, 50), /expected test failure/);
			tui.requestRender();
			await terminal.waitForRender();
			assert.equal(readFileSync(join(directory, "senpi-debug.log"), "utf8").split("render error:").length - 1, 1);
			failing = false;
			tui.requestRender();
			await terminal.waitForRender();
			assert.equal(terminal.getViewport()[0]!.trimEnd(), "recovered");
		} finally {
			tui.stop();
			f.view.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("charges empty row arrays against the render-cache budget", () => {
		const lines = Array.from({ length: 1_050_000 }, () => "");
		const { view, calls } = fixture(1, () => lines);
		view.renderEntry(0, 20);
		view.renderEntry(0, 20);
		assert.equal(calls.get(0), 2);
	});

	it("matches canonical row scrolling across mixed empty and variable-height entries", () => {
		const lines = Array.from({ length: 120 }, (_, index) =>
			Array.from({ length: (index * 17) % 6 }, (_, row) => `${index}:${row}`),
		);
		const all = lines.flat();
		const f = fixture(lines.length, (index) => lines[index]!);
		const settle = () => {
			let frame = f.render(30, 7);
			for (let i = 0; i < 30 && frame.root.entryFrame?.pending; i++) frame = f.render(30, 7);
			assert.equal(frame.root.entryFrame?.pending, false);
			return frame;
		};
		let top = Math.max(0, all.length - 7);
		assert.deepEqual(settle().lines, all.slice(top, top + 7));
		for (const delta of [-4, -30, 8, -1000, 15, 1, 80, 1000, -2]) {
			top = Math.max(0, Math.min(all.length - 7, top + delta));
			f.view.scrollBy(delta);
			assert.deepEqual(settle().lines, all.slice(top, top + 7), `delta ${delta}`);
		}
	});
	it("materializes all indexed entries only for an explicit canonical render", () => {
		const f = fixture(90);
		f.render();
		f.calls.clear();
		assert.deepEqual(
			f.view.render(30),
			Array.from({ length: 90 }, (_, index) => `entry ${index}`),
		);
		assert.ok(f.calls.has(0));
		f.calls.clear();
		assert.deepEqual(f.render().lines, ["entry 86", "entry 87", "entry 88", "entry 89"]);
		assert.ok(f.calls.size <= 4);
	});

	it("keeps nested auto-basis vertical and horizontal indexed measurement bounded", () => {
		const vertical = fixture(5_000);
		const nested = new VStack([new VStack([vertical.view]), new Text("dock", 0, 0)]);
		const frame = renderLayoutFrame(nested, 30, 5, () => {});
		assert.equal(getScrollViewBox(frame, vertical.view)?.rect.height, 1);
		assert.ok(vertical.calls.size <= 1);
		const horizontal = fixture(5_000);
		const columns = new HStack([new VStack([horizontal.view]), new Text("side", 0, 0)]);
		const horizontalFrame = renderLayoutFrame(columns, 30, 5, () => {});
		assert.equal(getScrollViewBox(horizontalFrame, horizontal.view)?.rect.height, 1);
		assert.ok(horizontal.calls.size <= 1);
	});

	it("prints the complete indexed document on generic fullscreen transcript exit", async () => {
		const terminal = new VirtualTerminal(30, 5);
		const tui = new TuiAltScreen(terminal);
		const f = fixture(90);
		tui.setLayoutRoot(new VStack([{ component: f.view, basis: 0, grow: 1 }, new Text("dock", 0, 0)]));
		tui.start();
		await terminal.waitForRender();
		tui.stop({ preserveScreen: false });
		await terminal.flush();
		const output = terminal.getScrollBuffer().map((line) => line.trimEnd());
		for (let index = 0; index < 90; index++) assert.ok(output.includes(`entry ${index}`), `missing entry ${index}`);
		assert.ok(output.includes("dock"));
		f.view.dispose();
	});
	it("keeps visible sibling intrinsic widths when an indexed descendant is hidden", () => {
		const f = fixture(5_000);
		const label = (text: string): Component => ({ render: () => [text], invalidate() {} });
		const layout = new HStack([new VStack([label("a"), { component: f.view, visible: () => false }]), label("b")]);
		const frame = renderLayoutFrame(layout, 30, 4, () => {});
		assert.equal(stripTerminalSequences(frame.lines[0]!).trimEnd(), "ab");
		assert.equal(f.calls.size, 0);
	});
	it("does not canonically render responsive hidden indexed descendants during intrinsic measurement", () => {
		const f = fixture(5_000);
		const label = (text: string): Component => ({ render: () => [text], invalidate() {} });
		const column = new VStack([label("a"), { component: f.view, visible: (viewport) => viewport.height > 100 }]);
		const frame = renderLayoutFrame(new HStack([column, label("b")]), 30, 40, () => {});
		assert.equal(stripTerminalSequences(frame.lines[0]!).trimEnd(), "ab");
		assert.equal(f.calls.size, 0);
	});
});
