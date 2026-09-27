import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as tui from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("component tail rendering", () => {
	it("visits only the visible suffix and never enters an unknown renderer synchronously", () => {
		const container = new tui.Container();
		let historicalRenders = 0;
		container.addChild({
			render: () => {
				historicalRenders++;
				return ["history"];
			},
			invalidate() {},
		});
		container.addChild({
			render: () => {
				throw new Error("full render forbidden");
			},
			renderTail: (_width: number, maxRows: number) => ({
				lines: ["a", "b", "c"].slice(-maxRows),
				pending: false,
				hasMore: maxRows < 3,
			}),
			invalidate() {},
		});
		const controller = new AbortController();
		const renderTail = Reflect.get(container, "renderTail");
		assert.equal(typeof renderTail, "function");
		const result = Reflect.apply(renderTail, container, [
			40,
			2,
			{ signal: controller.signal, revision: 1, requestRender() {} },
		]);
		assert.deepEqual(result.lines, ["b", "c"]);
		assert.equal(result.hasMore, true);
		assert.equal(historicalRenders, 0);
		controller.abort();
	});

	it("defers legacy callbacks, refreshes a content revision once and rejects an aborted generation", async () => {
		let renders = 0;
		let requests = 0;
		const component: tui.Component = { render: () => [`render ${++renders}`], invalidate() {} };
		const controller = new AbortController();
		const context = {
			signal: controller.signal,
			revision: 1,
			requestRender: () => {
				requests++;
			},
		};
		assert.equal(tui.renderComponentTail(component, 40, 4, context).pending, true);
		assert.equal(renders, 0);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(requests, 1);
		assert.deepEqual(tui.renderComponentTail(component, 40, 4, context).lines, ["render 1"]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(renders, 1, "completion does not restart preparation");
		assert.equal(tui.renderComponentTail(component, 40, 4, { ...context, revision: 2 }).pending, true);
		controller.abort();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(renders, 1, "an old generation cannot render or commit");
	});

	it("keeps a decorated Container on the explicit compatibility path", async () => {
		class Decorated extends tui.Container {
			calls = 0;
			override render(): string[] {
				this.calls++;
				return ["decorated"];
			}
		}
		const component = new Decorated();
		component.addChild({
			render() {
				throw new Error("decoration bypassed");
			},
			invalidate() {},
		});
		const controller = new AbortController();
		const context = { signal: controller.signal, revision: 1, requestRender() {} };
		assert.equal(tui.renderComponentTail(component, 40, 4, context).pending, true);
		assert.equal(component.calls, 0);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(tui.renderComponentTail(component, 40, 4, context).lines, ["decorated"]);
		assert.equal(component.calls, 1);
		controller.abort();
	});

	it("resizes the committed idle working region without rendering or replaying history", async () => {
		class RecordingTerminal extends VirtualTerminal {
			writes: string[] = [];
			override write(data: string): void {
				this.writes.push(data);
				super.write(data);
			}
			lastQuery?: Promise<{ row: number; column: number }>;
			queryCursorPosition() {
				this.lastQuery = this.flush().then(() => {
					const position = this.getCursorPosition();
					return { row: position.y + 1, column: position.x + 1 };
				});
				return this.lastQuery;
			}
		}
		const terminal = new RecordingTerminal(80, 8);
		const renderer = new TuiMainScreen(terminal);
		let fullRenders = 0;
		let historyTreeReads = 0;
		const history = Object.assign(new tui.Container(), {
			render: () => {
				fullRenders++;
				return Array.from({ length: 100 }, (_, i) => `unique history ${i}`);
			},
			invalidate() {},
		});
		Object.defineProperty(history, "children", {
			get() {
				historyTreeReads++;
				return [];
			},
		});
		const controls = (width: number) => [`border ${width}`, `${tui.CURSOR_MARKER}input`, "footer"];
		renderer.addChild(history);
		renderer.addChild({
			render: controls,
			renderTail: (width) => ({ lines: controls(width), pending: false, hasMore: false }),
			invalidate() {},
		});
		renderer.setWorkingRegionAfter(history, () => 1);
		try {
			renderer.renderNow();
			await terminal.flush();
			terminal.writes = [];
			historyTreeReads = 0;
			for (const width of [30, 100, 24, 80]) {
				terminal.resize(width, 8);
				renderer.renderNow();
				await terminal.lastQuery;
				renderer.renderNow();
				await terminal.flush();
				assert.equal(fullRenders, 1);
				assert.equal(historyTreeReads, 0, "native frames must not walk historical mouse layout");
				assert.deepEqual(terminal.getViewport().slice(-3), [`border ${width}`, "input", "footer"]);
			}
			assert.ok(terminal.getScrollBuffer().includes("unique history 0"));
			assert.ok(!terminal.writes.join("").includes("\x1b[3J"));
			assert.ok(!terminal.writes.join("").includes("unique history 0"));
		} finally {
			renderer.stop();
		}
	});

	it("retains every committed character once while native history reflows around the working region", async () => {
		const source = Array.from({ length: 100 }, (_, row) =>
			Array.from({ length: 32 }, (_, col) => String.fromCodePoint(0x4e00 + row * 32 + col)).join(""),
		);
		class CursorTerminal extends VirtualTerminal {
			lastQuery?: Promise<{ row: number; column: number }>;
			queryCursorPosition() {
				this.lastQuery = this.flush().then(() => {
					const position = this.getCursorPosition();
					return { row: position.y + 1, column: position.x + 1 };
				});
				return this.lastQuery;
			}
		}
		const terminal = new CursorTerminal(80, 8);
		const renderer = new tui.TUI(terminal);
		let fullRenders = 0;
		const history: tui.Component = {
			render: () => {
				fullRenders++;
				return source;
			},
			invalidate() {},
		};
		const controls = (width: number) => ["-".repeat(width), `${tui.CURSOR_MARKER}input`, "footer"];
		renderer.addChild(history);
		renderer.addChild({
			render: controls,
			renderTail: (width) => ({ lines: controls(width), pending: false, hasMore: false }),
			invalidate() {},
		});
		renderer.setWorkingRegionAfter(history, () => 1);
		try {
			renderer.renderNow();
			await terminal.flush();
			for (const width of [30, 80, 24, 80]) {
				terminal.resize(width, 8);
				renderer.renderNow();
				await terminal.lastQuery;
				renderer.renderNow();
				await terminal.flush();
			}
			assert.equal(fullRenders, 1);
			const counts = new Map<string, number>();
			for (const character of terminal.getScrollBuffer().join(""))
				counts.set(character, (counts.get(character) ?? 0) + 1);
			assert.deepEqual(
				[...source.join("")].filter((character) => counts.get(character) !== 1),
				[],
			);
		} finally {
			renderer.stop();
		}
	});

	it("rejects stale cursor replies and leaves an in-flight query inert after stop", async () => {
		class DeferredTerminal extends VirtualTerminal {
			writes: string[] = [];
			queries: Array<(position: { row: number; column: number } | undefined) => void> = [];
			override write(data: string): void {
				this.writes.push(data);
				super.write(data);
			}
			queryCursorPosition() {
				return new Promise<{ row: number; column: number } | undefined>((resolve) => this.queries.push(resolve));
			}
		}
		const terminal = new DeferredTerminal(80, 8);
		const renderer = new tui.TUI(terminal);
		let fullRenders = 0;
		const history = {
			render: () => {
				fullRenders++;
				return Array.from({ length: 40 }, (_, i) => `history ${i}`);
			},
			invalidate() {},
		};
		const controls = (width: number) => [`border ${width}`, `${tui.CURSOR_MARKER}input`, "footer"];
		renderer.addChild(history);
		renderer.addChild({
			render: controls,
			renderTail: (width) => ({ lines: controls(width), pending: false, hasMore: false }),
			invalidate() {},
		});
		renderer.setWorkingRegionAfter(history, () => 1);
		try {
			renderer.renderNow();
			await terminal.flush();
			terminal.resize(40, 8);
			renderer.renderNow();
			terminal.resize(60, 8);
			renderer.renderNow();
			const pendingWrites = terminal.writes.length;
			terminal.queries[0]({ row: 1, column: 1 });
			await Promise.resolve();
			renderer.renderNow();
			assert.equal(terminal.writes.length, pendingWrites, "old width cannot publish geometry");
			terminal.queries[1]({ row: 7, column: 1 });
			await Promise.resolve();
			renderer.renderNow();
			await terminal.flush();
			assert.deepEqual(terminal.getViewport().slice(-3), ["border 60", "input", "footer"]);
			assert.equal(fullRenders, 1);
			terminal.resize(50, 8);
			renderer.renderNow();
			renderer.stop();
			const stoppedWrites = terminal.writes.length;
			terminal.queries[2]({ row: 7, column: 1 });
			await Promise.resolve();
			assert.equal(terminal.writes.length, stoppedWrites);
		} finally {
			renderer.stop();
		}
	});

	it("uses canonical rendering for an unknown cursor or changed history revision", async () => {
		for (const failure of ["cursor", "revision", "marker"] as const) {
			class CursorTerminal extends VirtualTerminal {
				lastQuery?: Promise<{ row: number; column: number } | undefined>;
				queryCursorPosition() {
					this.lastQuery = Promise.resolve(failure === "cursor" ? undefined : { row: 7, column: 1 });
					return this.lastQuery;
				}
			}
			const terminal = new CursorTerminal(80, 8);
			const renderer = new tui.TUI(terminal);
			let fullRenders = 0;
			let revision: number | undefined = 1;
			let focused = true;
			const history = {
				render: () => {
					fullRenders++;
					return Array.from({ length: 40 }, (_, i) => `history ${i}`);
				},
				invalidate() {},
			};
			const controls = (width: number) => [`border ${width}`, `${focused ? tui.CURSOR_MARKER : ""}input`, "footer"];
			renderer.addChild(history);
			renderer.addChild({
				render: controls,
				renderTail: (width) => ({ lines: controls(width), pending: false, hasMore: false }),
				invalidate() {},
			});
			renderer.setWorkingRegionAfter(history, () => revision);
			try {
				renderer.renderNow();
				await terminal.flush();
				terminal.resize(40, 8);
				renderer.renderNow();
				await terminal.lastQuery;
				renderer.renderNow();
				await terminal.flush();
				if (failure === "revision") {
					revision = undefined;
					renderer.renderNow();
					await terminal.flush();
				}
				if (failure === "marker") {
					focused = false;
					renderer.renderNow();
					await terminal.flush();
				}
				assert.equal(fullRenders, 2);
				assert.deepEqual(terminal.getViewport().slice(-3), ["border 40", "input", "footer"]);
			} finally {
				renderer.stop();
			}
		}
	});

	it("rebuilds canonical geometry for existing or newly acquired mouse capture", async () => {
		for (const acquireAfterResize of [false, true]) {
			class CursorTerminal extends VirtualTerminal {
				lastQuery?: Promise<{ row: number; column: number }>;
				queryCursorPosition() {
					this.lastQuery = Promise.resolve({ row: 7, column: 1 });
					return this.lastQuery;
				}
			}
			const terminal = new CursorTerminal(80, 8);
			const renderer = new TuiMainScreen(terminal);
			let fullRenders = 0;
			const history = {
				render: () => {
					fullRenders++;
					return Array.from({ length: 40 }, (_, i) => `history ${i}`);
				},
				invalidate() {},
			};
			const controls = (width: number) => [`border ${width}`, `${tui.CURSOR_MARKER}input`, "footer"];
			renderer.addChild(history);
			renderer.addChild({
				render: controls,
				renderTail: (width) => ({ lines: controls(width), pending: false, hasMore: false }),
				invalidate() {},
			});
			renderer.setWorkingRegionAfter(history, () => 1);
			try {
				renderer.renderNow();
				await terminal.flush();
				if (!acquireAfterResize) renderer.acquireMouseCapture("historical-controls");
				terminal.resize(40, 8);
				renderer.renderNow();
				await terminal.lastQuery;
				if (acquireAfterResize) {
					renderer.renderNow();
					await terminal.flush();
					assert.equal(fullRenders, 1);
					renderer.acquireMouseCapture("historical-controls");
					renderer.renderNow();
					await terminal.flush();
				}
				assert.equal(fullRenders, 2);
			} finally {
				renderer.stop();
			}
		}
	});

	it("abandons native coordinates after an external write without erasing that output", async () => {
		class ExternalTerminal extends VirtualTerminal {
			listeners = new Set<() => void>();
			lastQuery?: Promise<{ row: number; column: number }>;
			queryCursorPosition() {
				this.lastQuery = Promise.resolve({ row: 7, column: 1 });
				return this.lastQuery;
			}
			observeExternalWrites(listener: () => void) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			externalWrite(data: string) {
				super.write(data);
				for (const listener of this.listeners) listener();
			}
		}
		const terminal = new ExternalTerminal(80, 8);
		const renderer = new TuiMainScreen(terminal);
		const history = { render: () => Array.from({ length: 40 }, (_, i) => `history ${i}`), invalidate() {} };
		const controls = (width: number) => [`border ${width}`, `${tui.CURSOR_MARKER}input`, "footer"];
		renderer.addChild(history);
		renderer.addChild({
			render: controls,
			renderTail: (width) => ({ lines: controls(width), pending: false, hasMore: false }),
			invalidate() {},
		});
		renderer.setWorkingRegionAfter(history, () => 1);
		try {
			renderer.renderNow();
			await terminal.flush();
			terminal.resize(40, 8);
			renderer.renderNow();
			await terminal.lastQuery;
			renderer.renderNow();
			await terminal.flush();
			assert.equal(terminal.listeners.size, 1);
			terminal.externalWrite("EXTERNAL-DIAGNOSTIC\r\n");
			renderer.renderNow();
			await terminal.flush();
			assert.equal(terminal.listeners.size, 0);
			assert.ok(terminal.getScrollBuffer().some((line) => line.includes("EXTERNAL-DIAGNOSTIC")));
		} finally {
			renderer.stop();
		}
	});
});
