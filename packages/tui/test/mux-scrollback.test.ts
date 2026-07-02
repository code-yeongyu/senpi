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
	it("emits a screen clear without clearing scrollback when width changes inside a multiplexer", async () => {
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
		assert.ok(writes.includes(SCREEN_CLEAR + HOME), "width change should clear and home the visible screen");
		assert.strictEqual(countOccurrences(writes, SCROLLBACK_CLEAR), 0, "width change must not clear mux pane history");
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
});
