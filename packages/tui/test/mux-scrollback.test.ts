import assert from "node:assert";
import { describe, it } from "node:test";
import { TUI } from "../src/tui.ts";
import {
	assertFrameBalanced,
	countOccurrences,
	ExpandableTranscriptComponent,
	HOME,
	KITTY_IMAGE_LINE,
	LoggingVirtualTerminal,
	muxOptions,
	nonMuxOptions,
	OverlayComponent,
	ROW_CLEAR,
	renderReplayTrigger,
	SCREEN_CLEAR,
	SCROLLBACK_CLEAR,
	StaticComponent,
	withEnv,
} from "./mux-scrollback-harness.ts";

describe("TUI multiplexer scrollback preservation", () => {
	it("does not clear scrollback when a non-multiplexer Windows terminal is resized", async () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		assert.ok(platformDescriptor);
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			const terminal = new LoggingVirtualTerminal(40, 6);
			const tui = new TUI(terminal, nonMuxOptions());
			const component = new StaticComponent();
			component.lines = ["alpha", "beta", "gamma"];
			tui.addChild(component);

			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			terminal.resize(50, 6);
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes(SCREEN_CLEAR + HOME), "width change should clear and home the visible screen");
			assert.strictEqual(
				countOccurrences(writes, SCROLLBACK_CLEAR),
				0,
				"Windows resize must not clear terminal scrollback",
			);
			assertFrameBalanced(writes);
			tui.stop();
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it("keeps clearing scrollback for non-Windows non-multiplexer resizes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, nonMuxOptions());
		const component = new StaticComponent();
		component.lines = ["alpha", "beta", "gamma"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(50, 6);
		await terminal.waitForRender();

		assert.strictEqual(countOccurrences(terminal.getWrites(), SCROLLBACK_CLEAR), 1);
		tui.stop();
	});

	it("homes and repaints the viewport without a screen or scrollback clear when width changes inside a multiplexer", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, muxOptions());
		const component = new StaticComponent();
		component.lines = ["alpha", "beta", "gamma"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(50, 6);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		// senpi#1704: a screen clear plus a re-emission of the whole buffer flooded the pane's history.
		// A real pane re-wraps its own screen on a width change, which the headless terminal here does not
		// model, so the repaint is pinned by its absolute home rather than by re-wrapped screen contents.
		assert.ok(writes.includes(HOME), "width change homes the cursor to repaint the visible screen");
		assert.strictEqual(countOccurrences(writes, SCREEN_CLEAR), 0, "width change must not clear the mux pane screen");
		assert.strictEqual(countOccurrences(writes, SCROLLBACK_CLEAR), 0, "width change must not clear mux pane history");
		assert.deepStrictEqual(terminal.getViewport().slice(0, 3), ["alpha", "beta", "gamma"]);
		assertFrameBalanced(writes);
		tui.stop();
	});

	it("repaints exactly the visible rows for offscreen line-count changes inside a multiplexer", async () => {
		const { terminal, tui, writes } = await renderReplayTrigger(muxOptions());

		assert.strictEqual(
			countOccurrences(writes, ROW_CLEAR),
			terminal.rows,
			"mux repaint should rewrite one row per viewport row",
		);
		assert.strictEqual(countOccurrences(writes, SCROLLBACK_CLEAR), 0, "mux repaint must not clear pane history");
		assert.strictEqual(countOccurrences(writes, SCREEN_CLEAR), 0, "mux repaint must not clear the screen");
		assert.strictEqual(tui.muxViewportRepaints, 1, "mux repaint counter should increment");
		assert.strictEqual(tui.fullRedraws, 1, "mux repaint should not increment full redraws after initial render");
		assert.deepStrictEqual(terminal.getViewport(), [
			"tail row 0",
			"tail row 1",
			"tail row 2",
			"tail row 3",
			"tail row 4",
			"tail row 5",
		]);
		assertFrameBalanced(writes);
		tui.stop();
	});

	it("clears stale rows when a short transcript is repainted in a tall mux viewport", async () => {
		const terminal = new LoggingVirtualTerminal(40, 8);
		const tui = new TUI(terminal, muxOptions());
		const component = new StaticComponent();
		component.lines = Array.from({ length: 12 }, (_, index) => `long row ${index}`);
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["short row 0", "short row 1", "short row 2"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["short row 0", "short row 1", "short row 2", "", "", "", "", ""]);
		assert.strictEqual(countOccurrences(terminal.getWrites(), SCROLLBACK_CLEAR), 0);
		tui.stop();
	});

	it("repaints height changes inside a multiplexer without screen or scrollback clears", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal, muxOptions());
		const component = new StaticComponent();
		component.lines = Array.from({ length: 20 }, (_, index) => `Line ${index}`);
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(40, 7);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.strictEqual(
			countOccurrences(writes, ROW_CLEAR),
			terminal.rows,
			"height change should repaint at most the visible rows",
		);
		assert.strictEqual(countOccurrences(writes, SCREEN_CLEAR), 0, "height change must not clear the screen in mux");
		assert.strictEqual(
			countOccurrences(writes, SCROLLBACK_CLEAR),
			0,
			"height change must not clear scrollback in mux",
		);
		assertFrameBalanced(writes);
		tui.stop();
	});

	it("uses a no-3J full render once for PI_CLEAR_ON_SHRINK inside a multiplexer", async () => {
		await withEnv({ PI_CLEAR_ON_SHRINK: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 6);
			const tui = new TUI(terminal, muxOptions());
			const component = new StaticComponent();
			component.lines = Array.from({ length: 10 }, (_, index) => `row ${index}`);
			tui.addChild(component);

			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			component.lines = ["row 0", "row 1"];
			tui.requestRender();
			await terminal.waitForRender();

			const shrinkWrites = terminal.getWrites();
			assert.ok(shrinkWrites.includes(SCREEN_CLEAR + HOME), "clear-on-shrink should full-render the viewport");
			assert.strictEqual(
				countOccurrences(shrinkWrites, SCROLLBACK_CLEAR),
				0,
				"clear-on-shrink must preserve mux history",
			);
			const fullRedrawsAfterShrink = tui.fullRedraws;

			terminal.clearWrites();
			tui.requestRender();
			await terminal.waitForRender();

			assert.strictEqual(
				tui.fullRedraws,
				fullRedrawsAfterShrink,
				"maxLinesRendered should prevent repeated shrink clears",
			);
			assert.strictEqual(terminal.getWrites(), "", "unchanged follow-up frame should not repaint");
			tui.stop();
		});
	});

	it("falls back to a no-3J full render when a kitty image is in the mux viewport", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, muxOptions());
		const component = new StaticComponent();
		component.lines = ["before", KITTY_IMAGE_LINE, "after"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(40, 5);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes(SCREEN_CLEAR + HOME), "kitty image rows should bail to full render");
		assert.strictEqual(
			countOccurrences(writes, SCROLLBACK_CLEAR),
			0,
			"kitty image full render should preserve mux history",
		);
		assert.strictEqual(tui.muxViewportRepaints, 0, "kitty image rows should not use raw viewport repaint");
		tui.stop();
	});

	it("keeps open overlays composited when a mux replay trigger repaints the viewport", async () => {
		const terminal = new LoggingVirtualTerminal(72, 6);
		const tui = new TUI(terminal, muxOptions());
		const component = new ExpandableTranscriptComponent();
		tui.addChild(component);
		component.setExpanded(true);
		tui.start();
		await terminal.waitForRender();
		tui.showOverlay(new OverlayComponent(), { anchor: "top-left", width: 20 });
		await terminal.waitForRender();
		terminal.clearWrites();

		component.setExpanded(false);
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.strictEqual(countOccurrences(writes, SCROLLBACK_CLEAR), 0, "overlay mux repaint must preserve scrollback");
		assert.strictEqual(tui.muxViewportRepaints, 1, "overlay replay should use the mux repaint path");
		assert.ok(terminal.getViewport()[0]?.startsWith("OVERLAY"), "overlay row should remain composited after repaint");
		tui.stop();
	});

	it("restores legacy scrollback-clearing byte shape when PI_TUI_LEGACY_MUX_RENDER is enabled", async () => {
		await withEnv({ PI_TUI_LEGACY_MUX_RENDER: "1" }, async () => {
			const { tui, writes } = await renderReplayTrigger(muxOptions());

			assert.ok(writes.includes(SCROLLBACK_CLEAR), "legacy mux rendering should clear scrollback");
			assert.strictEqual(tui.muxViewportRepaints, 0, "legacy mux rendering should not use the mux repaint path");
			tui.stop();
		});
	});

	it("keeps muxDetector false byte-identical to the default non-mux path", async () => {
		const baseline = await renderReplayTrigger(undefined);
		const injected = await renderReplayTrigger(nonMuxOptions());

		assert.strictEqual(injected.writes, baseline.writes);
		assert.strictEqual(injected.tui.fullRedraws, baseline.tui.fullRedraws);
		baseline.tui.stop();
		injected.tui.stop();
	});

	// senpi#1704: a tmux focus event and a pane width change re-emitted the WHOLE transcript buffer, flooding the pane's
	// history with a copy of it per event. Inside a multiplexer only the viewport is repainted.
	it("repaints only the viewport on a tmux focus event, and nothing at all on focus out", async () => {
		await withEnv({ TMUX: "/tmp/tmux-test,1,0" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 6);
			const tui = new TUI(terminal, muxOptions());
			const component = new StaticComponent();
			component.lines = Array.from({ length: 60 }, (_, index) => `transcript row ${index}`);
			tui.addChild(component);

			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			terminal.sendInput("\x1b[O");
			await terminal.waitForRender();
			assert.strictEqual(terminal.getWrites(), "", "focus out repaints nothing: the pane is not visible");

			terminal.sendInput("\x1b[I");
			await terminal.waitForRender();
			const writes = terminal.getWrites();
			assert.strictEqual(countOccurrences(writes, SCREEN_CLEAR), 0, "focus in must not clear the screen");
			assert.ok(
				countOccurrences(writes, ROW_CLEAR) <= terminal.rows,
				`focus in repaints at most the visible rows, not the ${component.lines.length}-row transcript`,
			);
			assert.ok(!writes.includes("transcript row 0\r"), "rows above the viewport are not re-emitted");
			assertFrameBalanced(writes);
			tui.stop();
		});
	});

	it("repaints only the re-wrapped viewport when the pane width changes inside a multiplexer", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, muxOptions());
		const component = new StaticComponent();
		component.lines = Array.from({ length: 60 }, (_, index) => `transcript row ${index}`);
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(36, 6);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.strictEqual(countOccurrences(writes, SCREEN_CLEAR), 0, "width change in mux must not clear the screen");
		assert.strictEqual(countOccurrences(writes, SCROLLBACK_CLEAR), 0, "width change must not clear mux pane history");
		assert.ok(countOccurrences(writes, ROW_CLEAR) <= terminal.rows, "only the visible rows are rewritten");
		assert.ok(!writes.includes("transcript row 0"), "rows above the viewport are not re-emitted into pane history");
		assert.deepStrictEqual(terminal.getViewport().at(-1), "transcript row 59");
		assertFrameBalanced(writes);
		tui.stop();
	});

	// Review of #2882: a frame that grew the content was still pending when the focus event arrived; the
	// repaint must show the grown bottom (the editor/status rows), not the viewport of the frame before it.
	it("follows content a pending frame added when a tmux focus event repaints the viewport", async () => {
		await withEnv({ TMUX: "/tmp/tmux-test,1,0" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 6);
			const tui = new TUI(terminal, muxOptions());
			const component = new StaticComponent();
			component.lines = Array.from({ length: 20 }, (_, index) => `transcript row ${index}`);
			tui.addChild(component);

			tui.start();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[O");
			await terminal.waitForRender();

			component.lines = [...component.lines, "status row", "editor row"];
			tui.requestRender();
			const repaintsBefore = tui.muxViewportRepaints;
			terminal.sendInput("\x1b[I");
			await terminal.waitForRender();

			assert.deepStrictEqual(terminal.getViewport().slice(-2), ["status row", "editor row"]);
			assert.strictEqual(tui.muxViewportRepaints - repaintsBefore, 1, "the focus-in is one viewport repaint");
			// The repaint records the grown frame as drawn, so the next keystroke diffs against what is on screen.
			component.lines = [...component.lines.slice(0, -1), "editor row typed"];
			tui.requestRender();
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport().slice(-2), ["status row", "editor row typed"]);
			tui.stop();
		});
	});

	it("repaints the visible rows on a tmux focus-in, not nothing", async () => {
		await withEnv({ TMUX: "/tmp/tmux-test,1,0" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 6);
			const tui = new TUI(terminal, muxOptions());
			const component = new StaticComponent();
			component.lines = Array.from({ length: 20 }, (_, index) => `transcript row ${index}`);
			tui.addChild(component);

			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			terminal.sendInput("\x1b[I");
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.strictEqual(countOccurrences(writes, ROW_CLEAR), terminal.rows, "focus in rewrites every visible row");
			assert.ok(writes.includes("transcript row 19"), "the bottom row is repainted");
			tui.stop();
		});
	});

	it("keeps a forced render inside a multiplexer a full render, not a viewport repaint", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, muxOptions());
		const component = new StaticComponent();
		component.lines = Array.from({ length: 20 }, (_, index) => `transcript row ${index}`);
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();
		const repaintsBefore = tui.muxViewportRepaints;

		// A forced render resets every cached frame (previousWidth -1): it is not a width change to re-wrap.
		tui.requestRender(true);
		await terminal.waitForRender();

		assert.strictEqual(tui.muxViewportRepaints, repaintsBefore, "a forced render takes the full-render path");
		assert.strictEqual(
			countOccurrences(terminal.getWrites(), SCROLLBACK_CLEAR),
			0,
			"inside a multiplexer, without 3J",
		);
		assert.deepStrictEqual(terminal.getViewport().at(-1), "transcript row 19");
		tui.stop();
	});

	// Review round 2 of #2882: after a shrink the viewport keeps its top, so a focus-in must not scroll the
	// rows above it (already in the pane's history) into view a second time.
	it("keeps the viewport top after a shrink when a tmux focus event repaints", async () => {
		await withEnv({ TMUX: "/tmp/tmux-test,1,0" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 6);
			const tui = new TUI(terminal, muxOptions());
			const component = new StaticComponent();
			component.lines = Array.from({ length: 30 }, (_, index) => `transcript row ${index}`);
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			component.lines = component.lines.slice(0, 26);
			tui.requestRender();
			await terminal.waitForRender();
			const afterShrink = terminal.getViewport();
			terminal.clearWrites();

			terminal.sendInput("\x1b[I");
			await terminal.waitForRender();

			assert.deepStrictEqual(terminal.getViewport(), afterShrink);
			assert.ok(!terminal.getWrites().includes("transcript row 20"), "rows above the viewport are not re-emitted");
			tui.stop();
		});
	});
});
