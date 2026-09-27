import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IndexedAltScreenSearchIndex, IndexedAltScreenSearchMatch } from "../src/alt-screen-search.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import type { ScrollEntry, ScrollEntrySource } from "../src/layout-node.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Entries implements ScrollEntrySource {
	version = 0;
	displayRevision = 0;
	readonly entries: ScrollEntry[] = [];
	readonly lines: string[][] = [];
	readonly indices = new Map<object, number>();
	readonly changes: Array<{ version: number; index: number }> = [];
	renders = 0;
	reads = 0;
	onRender?: (index: number) => void;
	get length(): number {
		return this.entries.length;
	}
	get(index: number): ScrollEntry {
		this.reads += 1;
		return this.entries[index]!;
	}
	indexOf(key: object): number | undefined {
		return this.indices.get(key);
	}
	resolve(key: object, hint: number): number | undefined {
		return this.indexOf(key) ?? Math.min(hint, this.length - 1);
	}
	changedSince(version: number): number {
		return Math.min(
			Infinity,
			...this.changes.filter((change) => change.version > version).map((change) => change.index),
		);
	}
	add(text: string, known = true, prompt: boolean | undefined = false): void {
		const index = this.length;
		this.lines.push(text.split("\n"));
		const component: Component = {
			invalidate() {},
			render: () => {
				this.renders += 1;
				this.onRender?.(index);
				return this.lines[index]!;
			},
		};
		const entry: ScrollEntry = {
			key: component,
			component,
			sourceIndex: index,
			revision: known ? 0 : undefined,
			prompt,
		};
		this.indices.set(component, index);
		this.entries.push(entry);
		this.changes.push({ version: ++this.version, index });
	}
	change(index: number, text: string): void {
		this.lines[index] = text.split("\n");
		const entry = this.entries[index]!;
		this.entries[index] = { ...entry, revision: entry.revision === undefined ? undefined : entry.revision + 1 };
		this.changes.push({ version: ++this.version, index });
	}
}

function setup(text: string[], height = 3, known = true) {
	const source = new Entries();
	for (const line of text) source.add(line, known);
	const terminal = new VirtualTerminal(24, height);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copyOnSelect: false,
		copySelection: async (value) => {
			copied.push(value);
			return true;
		},
	});
	const document: Component = {
		invalidate() {},
		render() {
			throw new Error("ordinary frames must not render the complete document");
		},
	};
	const scroll = new ScrollView(document, { entries: source, primary: true });
	tui.setLayoutRoot(scroll);
	tui.start();
	tui.renderNow(true);
	return { source, terminal, copied, tui, scroll, stop: () => tui.stop({ preserveScreen: true }) };
}
function drag(terminal: VirtualTerminal, start: [number, number], end: [number, number]): void {
	terminal.sendInput(`\x1b[<0;${start[0]};${start[1]}M`);
	terminal.sendInput(`\x1b[<32;${end[0]};${end[1]}M`);
	terminal.sendInput(`\x1b[<0;${end[0]};${end[1]}m`);
}

describe("indexed fullscreen consumers", () => {
	it("copies reversed cross-entry graphemes offscreen without rendering unrelated history", async () => {
		const h = setup(["A界🙂éZ", "second", "third", ...Array.from({ length: 2000 }, (_, i) => `unrelated ${i}`)]);
		try {
			drag(h.terminal, [3, 2], [3, 1]);
			h.tui.renderNow(true);
			h.tui.scrollBy(8);
			h.tui.renderNow(true);
			const before = h.source.renders;
			for (let i = 0; i < 50; i++) assert.equal(h.tui.hasActiveSelection(), true);
			assert.equal(h.source.renders, before, "checking selection must not format history");
			assert.equal(await h.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(h.copied, ["界🙂éZ\nsec"]);
			assert.ok(h.source.renders - before <= 2);
		} finally {
			h.stop();
		}
	});

	it("preserves completed selection through appends and focus, then cancels on reflow", async () => {
		const h = setup(["alpha", "beta", "gamma"]);
		try {
			drag(h.terminal, [1, 1], [2, 2]);
			h.tui.renderNow(true);
			h.source.add("tail");
			h.tui.renderNow(true);
			h.terminal.sendInput("\x1b[O");
			h.terminal.sendInput("\x1b[I");
			assert.equal(h.tui.hasActiveSelection(), true);
			assert.equal(await h.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(h.copied, ["alpha\nbe"]);
			h.terminal.resize(18, 3);
			h.tui.renderNow(true);
			assert.equal(h.tui.hasActiveSelection(), false);
		} finally {
			h.stop();
		}
	});

	it("invalidates a middle mutation even when dragging replaces the focus with a newer point", () => {
		const h = setup(["alpha", "beta", "gamma", "delta"], 4);
		try {
			h.terminal.sendInput("\x1b[<0;1;1M");
			h.terminal.sendInput("\x1b[<32;2;3M");
			h.tui.renderNow(true);
			h.source.change(1, "changed");
			h.terminal.sendInput("\x1b[<32;2;4M");
			assert.equal(h.tui.hasActiveSelection(), false);
		} finally {
			h.stop();
		}
	});

	it("allows a stable range copy during tail appends but rejects selected-entry render side effects", async () => {
		const h = setup(["alpha", "beta", "gamma"], 3, false);
		try {
			drag(h.terminal, [1, 1], [2, 2]);
			h.tui.renderNow(true);
			h.source.onRender = (index) => {
				if (index === 1) {
					h.source.onRender = undefined;
					h.source.add("appended");
				}
			};
			assert.equal(await h.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(h.copied, ["alpha\nbe"]);
			h.source.onRender = (index) => {
				if (index === 1) {
					h.source.onRender = undefined;
					h.source.change(0, "mutated");
				}
			};
			assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
			assert.equal(h.copied.length, 1);
		} finally {
			h.stop();
		}
	});

	it("checks unknown endpoint rows on copy after they scroll out of view", async () => {
		const h = setup(["alpha", "beta", "gamma", "delta", "epsilon"], 3, false);
		try {
			drag(h.terminal, [1, 1], [2, 3]);
			h.tui.renderNow(true);
			h.tui.scrollBy(3);
			h.tui.renderNow(true);
			h.source.lines[0] = ["closure changed without revision"];
			assert.equal(await h.tui.copyActiveSelectionToClipboard(), false);
			assert.deepEqual(h.copied, []);
		} finally {
			h.stop();
		}
	});

	it("copies complete current unknown interior entries when a drag jumps across unseen entries", async () => {
		const h = setup(["alpha", "beta", "gamma", "delta", "epsilon"], 1, false);
		try {
			h.terminal.sendInput("\x1b[<0;1;1M");
			const end = h.source.entries[4]!;
			h.scroll.scrollToAnchor({ key: end.key, sourceIndex: 4, row: 0 });
			h.tui.renderNow(true);
			h.terminal.sendInput("\x1b[<32;2;1M");
			h.terminal.sendInput("\x1b[<0;2;1m");
			h.tui.renderNow(true);
			assert.equal(await h.tui.copyActiveSelectionToClipboard(), true);
			assert.deepEqual(h.copied, ["alpha\nbeta\ngamma\ndelta\nep"]);
		} finally {
			h.stop();
		}
	});

	it("uses prompt metadata without formatting intervening known non-prompt entries", async () => {
		const h = setup(["start", ...Array.from({ length: 100 }, (_, i) => `ordinary ${i}`), "\x1b]133;A\x07target"], 1);
		try {
			h.source.entries[101] = { ...h.source.entries[101]!, prompt: true };
			const before = h.source.renders;
			h.terminal.sendInput("\x1b[1;5B");
			await new Promise<void>((resolve) => setImmediate(resolve));
			h.tui.renderNow(true);
			await h.terminal.flush();
			assert.equal(h.terminal.getViewport()[0]?.trim(), "target");
			assert.ok(h.source.renders - before <= 2);
		} finally {
			h.stop();
		}
	});
	it("cancels captured mouse targets before stale resize or source-removal events can activate them", () => {
		const h = setup(["button", "tail"], 2);
		try {
			const events: string[] = [];
			h.source.entries[0]!.component.handleMouse = (event) => {
				events.push(event.type);
				return { handled: true, capture: event.type === "press" };
			};
			h.terminal.sendInput("\x1b[<0;1;1M");
			assert.deepEqual(events, ["press"]);
			h.terminal.resize(18, 2);
			h.terminal.sendInput("\x1b[<0;1;1m");
			h.tui.renderNow();
			assert.deepEqual(events, ["press"]);
			h.terminal.sendInput("\x1b[<0;1;1M");
			h.source.change(0, "replacement");
			h.terminal.sendInput("\x1b[<0;1;1m");
			assert.deepEqual(events, ["press", "press"]);
		} finally {
			h.stop();
		}
	});

	it("cancels a yielded copy on stop without sending stale clipboard text", async () => {
		const h = setup(["alpha", "beta", "gamma"]);
		try {
			drag(h.terminal, [1, 1], [2, 3]);
			h.tui.renderNow();
			const pending = h.tui.copyActiveSelectionToClipboard();
			h.stop();
			assert.equal(await pending, false);
			assert.deepEqual(h.copied, []);
		} finally {
			h.stop();
		}
	});
	it("integrates cross-entry search without rescanning history on idle paints", async () => {
		const h = setup(
			["alpha QUICK", "brown fox", ...Array.from({ length: 300 }, (_, i) => `filler ${i}`), "quick", "brown final"],
			8,
		);
		try {
			h.terminal.resize(120, 8);
			h.tui.renderNow();
			h.terminal.sendInput("\x1b[102;6u");
			h.terminal.sendInput("quick brown");
			h.tui.renderNow();
			const state = h.tui as unknown as {
				activeSearch: {
					entryIndex: IndexedAltScreenSearchIndex;
					entryMatches: readonly IndexedAltScreenSearchMatch[];
					selectedIndex: number;
				};
			};
			await state.activeSearch.entryIndex.whenIdle();
			h.tui.renderNow();
			assert.equal(state.activeSearch.entryMatches.length, 2);
			assert.equal(state.activeSearch.entryMatches[0]!.segments.length, 2);
			const reads = h.source.reads;
			const renders = h.source.renders;
			for (let frame = 0; frame < 20; frame++) h.tui.renderNow();
			assert.ok(h.source.reads - reads < 400, "ordinary paint must not scan the 304-entry source");
			assert.equal(h.source.renders, renders);
			h.terminal.sendInput("\r");
			h.tui.renderNow();
			await new Promise<void>((resolve) => setImmediate(resolve));
			h.tui.renderNow();
			assert.equal(state.activeSearch.selectedIndex, 1);
			assert.equal(h.scroll.scrollTop, 296);
			h.terminal.sendInput("\x1b");
			h.tui.renderNow();
			assert.equal(state.activeSearch, undefined);
		} finally {
			h.stop();
		}
	});

	it("rejects a stale unknown search target before jumping to its old row", async () => {
		const h = setup(
			["needle first", ...Array.from({ length: 12 }, (_, i) => `filler ${i}`), "needle last"],
			6,
			false,
		);
		try {
			h.terminal.resize(100, 6);
			h.tui.renderNow();
			h.terminal.sendInput("\x1b[102;6u");
			h.terminal.sendInput("needle");
			h.tui.renderNow();
			const state = h.tui as unknown as {
				activeSearch: { entryIndex: IndexedAltScreenSearchIndex; selectedIndex: number };
			};
			await state.activeSearch.entryIndex.whenIdle();
			h.tui.renderNow();
			h.source.lines[13] = ["target no longer exists"];
			h.terminal.sendInput("\r");
			h.tui.renderNow();
			await new Promise<void>((resolve) => setImmediate(resolve));
			h.tui.renderNow();
			assert.equal(state.activeSearch.selectedIndex, -1);
			assert.equal(h.scroll.scrollTop, 0);
		} finally {
			h.stop();
		}
	});
	it("budgets unknown prompt work between entries and cancels after renderer mutation", async (t) => {
		const h = setup(["first", ...Array.from({ length: 80 }, (_, i) => `ordinary ${i}`)], 1, false);
		try {
			for (let index = 0; index < h.source.length; index++)
				h.source.entries[index] = { ...h.source.entries[index]!, prompt: undefined };
			let elapsed = 0;
			t.mock.method(performance, "now", () => elapsed);
			h.source.onRender = () => {
				elapsed += 10;
			};
			const before = h.source.renders;
			h.terminal.sendInput("\x1b[1;5B");
			assert.equal(h.source.renders - before, 1, "yield after one entry exceeds the 8ms budget");
			h.tui.scrollToBottom();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(h.source.renders - before, 1, "later navigation cancels the deferred prompt scan");
			h.source.onRender = undefined;
			h.tui.scrollToTop();
			h.tui.renderNow();
			h.source.lines[1] = ["\x1b]133;A\x07old prompt"];
			h.source.onRender = (index) => {
				if (index === 1) {
					h.source.onRender = undefined;
					h.source.change(1, "removed");
				}
			};
			h.terminal.sendInput("\x1b[1;5B");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(h.scroll.scrollTop, 0, "a renderer's source mutation invalidates its returned prompt position");
		} finally {
			h.stop();
		}
	});

	it("cancels a one-entry copy at the final clipboard microtask boundary", async () => {
		const h = setup(["alpha"], 1);
		try {
			drag(h.terminal, [1, 1], [3, 1]);
			const pending = h.tui.copyActiveSelectionToClipboard();
			h.stop();
			assert.equal(await pending, false);
			assert.deepEqual(h.copied, []);
		} finally {
			h.stop();
		}
	});

	it("budgets a long cross-entry search reveal and cancels it when search closes", async (t) => {
		const h = setup(
			Array.from({ length: 50 }, () => "word"),
			1,
			false,
		);
		try {
			h.terminal.sendInput("\x1b[102;6u");
			h.terminal.sendInput(Array.from({ length: 50 }, () => "word").join(" "));
			h.tui.renderNow();
			const state = h.tui as unknown as { activeSearch: { entryIndex: IndexedAltScreenSearchIndex } };
			await state.activeSearch.entryIndex.whenIdle();
			let elapsed = 0;
			t.mock.method(performance, "now", () => elapsed);
			h.source.onRender = () => {
				elapsed += 10;
			};
			h.tui.renderNow();
			const before = h.source.renders;
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(h.source.renders - before, 1, "reveal yields after the first expensive entry");
			h.terminal.sendInput("\x1b");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(h.source.renders - before, 1, "closed search cannot continue rendering witness entries");
		} finally {
			h.stop();
		}
	});
	it("releases indexed matches when a search switches to a legacy layout", async () => {
		const h = setup(["needle"], 3);
		try {
			h.terminal.sendInput("\x1b[102;6u");
			h.terminal.sendInput("needle");
			h.tui.renderNow();
			const state = h.tui as unknown as {
				activeSearch: {
					entryIndex: IndexedAltScreenSearchIndex;
					entryMatches: readonly IndexedAltScreenSearchMatch[];
				};
			};
			await state.activeSearch.entryIndex.whenIdle();
			h.tui.renderNow();
			assert.equal(state.activeSearch.entryMatches.length, 1);
			h.tui.setLayoutRoot(new ScrollView({ invalidate() {}, render: () => ["legacy"] }, { primary: true }));
			h.tui.renderNow();
			assert.deepEqual(state.activeSearch.entryMatches, []);
		} finally {
			h.stop();
		}
	});
	it("cancels prompt and search continuations when the terminal resizes before repaint", async (t) => {
		for (const mode of ["prompt", "search"]) {
			const h = setup(
				Array.from({ length: 80 }, () => "word"),
				1,
				false,
			);
			try {
				for (let index = 0; index < h.source.length; index++)
					h.source.entries[index] = { ...h.source.entries[index]!, prompt: undefined };
				if (mode === "search") {
					h.terminal.sendInput("\x1b[102;6u");
					h.terminal.sendInput(Array.from({ length: 80 }, () => "word").join(" "));
					h.tui.renderNow();
					const state = h.tui as unknown as { activeSearch: { entryIndex: IndexedAltScreenSearchIndex } };
					await state.activeSearch.entryIndex.whenIdle();
				}
				let elapsed = 0;
				t.mock.method(performance, "now", () => elapsed);
				h.source.onRender = () => {
					elapsed += 10;
				};
				if (mode === "search") {
					h.tui.renderNow();
					await new Promise<void>((resolve) => setImmediate(resolve));
				} else h.terminal.sendInput("\x1b[1;5B");
				const before = h.source.renders;
				t.mock.method(h.tui, "requestRender", () => {});
				h.terminal.resize(18, 1);
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(h.source.renders, before, `${mode} must not read additional old-width entries`);
				assert.equal(h.scroll.scrollTop, 0);
			} finally {
				h.stop();
				t.mock.restoreAll();
			}
		}
	});
	it("releases prior indexed search ownership before a replacement layout paints", async () => {
		const h = setup(["needle old"], 3);
		try {
			h.terminal.sendInput("\x1b[102;6u");
			h.terminal.sendInput("needle");
			h.tui.renderNow();
			const state = h.tui as unknown as {
				activeSearch: {
					entryIndex: IndexedAltScreenSearchIndex;
					entryMatches: readonly IndexedAltScreenSearchMatch[];
					entryAnchor?: { key: object };
					selectedKey?: string;
					selectedIndex: number;
					query: string;
				};
			};
			await state.activeSearch.entryIndex.whenIdle();
			h.tui.renderNow();
			h.terminal.sendInput("x");
			assert.equal(state.activeSearch.entryAnchor?.key, h.source.entries[0]!.key);
			const next = new Entries();
			next.add("new transcript");
			h.tui.setLayoutRoot(new ScrollView({ invalidate() {}, render: () => [] }, { primary: true, entries: next }));
			assert.equal(state.activeSearch.entryAnchor, undefined);
			assert.deepEqual(state.activeSearch.entryMatches, []);
			assert.equal(state.activeSearch.selectedKey, undefined);
			assert.equal(state.activeSearch.selectedIndex, -1);
			assert.equal(state.activeSearch.query, "needlex", "preserve the open query and input UI");
		} finally {
			h.stop();
		}
	});
	it("releases captured and hovered old mouse owners before a replacement layout paints", () => {
		const h = setup(["old button", "tail"], 1);
		try {
			const events: string[] = [];
			h.source.entries[0]!.component.handleMouse = (event) => {
				events.push(event.type);
				return { handled: true, capture: true };
			};
			h.scroll.setScrollbar("always");
			h.tui.renderNow();
			h.terminal.sendInput("\x1b[<35;24;1M");
			h.terminal.sendInput("\x1b[<0;1;1M");
			const state = h.tui as unknown as {
				mouseCapture?: object;
				mousePressTarget?: object;
				lastClick?: object;
				scrollbarHover?: object;
				scrollbarDrag?: object;
			};
			assert.ok(state.mouseCapture);
			h.tui.setLayoutRoot(new ScrollView({ invalidate() {}, render: () => ["replacement"] }, { primary: true }));
			assert.equal(state.mouseCapture, undefined);
			assert.equal(state.mousePressTarget, undefined);
			assert.equal(state.lastClick, undefined);
			assert.equal(state.scrollbarHover, undefined);
			assert.equal(state.scrollbarDrag, undefined);
			h.terminal.sendInput("\x1b[<0;1;1m");
			assert.deepEqual(events, ["press"]);
			h.tui.setLayoutRoot(h.scroll);
			h.tui.renderNow();
			h.terminal.sendInput("\x1b[<0;24;1M");
			assert.ok(state.scrollbarHover);
			assert.ok(state.scrollbarDrag);
			h.tui.setLayoutRoot(new ScrollView({ invalidate() {}, render: () => ["replacement"] }, { primary: true }));
			assert.equal(state.scrollbarHover, undefined);
			assert.equal(state.scrollbarDrag, undefined);
		} finally {
			h.stop();
		}
	});
});
