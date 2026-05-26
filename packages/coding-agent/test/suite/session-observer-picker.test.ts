import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SessionHudOverlay } from "../../src/core/extensions/builtin/session-observer/overlay.ts";
import type { SessionHudEntry } from "../../src/core/extensions/builtin/session-observer/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const BASE_SESSION: SessionHudEntry = {
	id: "session-alpha",
	shortId: "session-",
	path: "/tmp/session-alpha.jsonl",
	cwd: "/Users/yeongyu/local-workspaces/senpi/packages/coding-agent",
	createdAt: Date.UTC(2026, 4, 26, 8, 0, 0),
	modifiedAt: Date.UTC(2026, 4, 26, 8, 9, 0),
	messageCount: 2,
	lastUserText: "Reply exactly: ok",
	isCurrent: false,
};

function createOverlay(sessions: readonly SessionHudEntry[]): SessionHudOverlay {
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
	return new SessionHudOverlay({
		sessions,
		done: () => {},
		requestRender: () => {},
	});
}

function plainLines(overlay: SessionHudOverlay, width: number): readonly string[] {
	return overlay.render(width).map((line) => stripAnsi(line));
}

function hasBorderOnlyLine(lines: readonly string[]): boolean {
	return lines.some((line) => /^─+$/.test(line));
}

describe("SessionHudOverlay picker", () => {
	it("renders the sessions heading first without full-width border chrome", () => {
		// given
		const overlay = createOverlay([BASE_SESSION]);

		// when
		const lines = plainLines(overlay, 100).filter((line) => line.length > 0);

		// then
		expect(lines[0], "first visible picker row should be the sessions heading").toContain("Sessions");
		expect(hasBorderOnlyLine(lines), "picker should not render full-width horizontal rules").toBe(false);
		expect(lines.join("\n"), "picker should keep the selected session row").toContain("→ Reply exactly: ok");
	});

	it("renders an empty picker without border-only rows", () => {
		// given
		const overlay = createOverlay([]);

		// when
		const lines = plainLines(overlay, 80).filter((line) => line.length > 0);

		// then
		expect(lines.join("\n"), "empty picker should still identify the sessions surface").toContain("Sessions");
		expect(hasBorderOnlyLine(lines), "empty picker should not render full-width horizontal rules").toBe(false);
	});

	it("keeps long session metadata within the viewport without border-only rows", () => {
		// given
		const overlay = createOverlay([
			{
				...BASE_SESSION,
				lastUserText:
					"Summarize every changed TypeScript file in the coding agent package and keep the answer extremely concise",
				cwd: "/Users/yeongyu/local-workspaces/senpi/packages/coding-agent/src/core/extensions/builtin/session-observer",
			},
		]);

		// when
		const lines = plainLines(overlay, 72).filter((line) => line.length > 0);

		// then
		expect(hasBorderOnlyLine(lines), "long metadata picker should not render full-width horizontal rules").toBe(
			false,
		);
		expect(
			lines.every((line) => visibleWidth(line) <= 72),
			"picker rows should stay within the viewport",
		).toBe(true);
	});
});
