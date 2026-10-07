import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { getMarkdownTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";

const WIDTH = 120 as const;
const HISTORY = 3000 as const;

initTheme("dark");

class CountedEntry implements Component {
	renders = 0;
	private readonly box: Box;
	private readonly body: Markdown;

	readonly index: number;

	constructor(index: number) {
		this.index = index;
		this.box = new Box(1, 0);
		this.body = new Markdown(
			`**Entry ${index}**: some *markdown* text for entry ${index}.`,
			0,
			0,
			getMarkdownTheme(),
		);
		this.box.addChild(new Spacer(1));
		this.box.addChild(this.body);
	}

	setText(text: string): void {
		this.body.setText(text);
	}

	render(width: number): string[] {
		this.renders += 1;
		return this.box.render(width);
	}

	invalidate(): void {
		this.box.invalidate();
	}

	getRenderRevision(): number | undefined {
		return this.box.getRenderRevision();
	}
}

class UnrevisionedClock implements Component {
	ticks = 0;

	render(): string[] {
		this.ticks += 1;
		return [`tick ${this.ticks}`];
	}

	invalidate(): void {}
}

function hydratedTranscript(count: number): { transcript: ExplorationTranscriptContainer; entries: CountedEntry[] } {
	const transcript = new ExplorationTranscriptContainer({
		tailBudget: count,
		warmChunkSize: count,
		requestRender: () => {},
	});
	const entries: CountedEntry[] = [];
	for (let index = 0; index < count; index++) {
		const entry = new CountedEntry(index);
		entries.push(entry);
		transcript.addChild(entry);
	}
	return { transcript, entries };
}

function rendersSince(entries: readonly CountedEntry[], before: readonly number[]): number {
	return entries.reduce((sum, entry, index) => sum + entry.renders - (before[index] ?? 0), 0);
}

describe("a huge transcript stays cheap to repaint", () => {
	it("repaints for typing without rendering any settled history entry", () => {
		// Given: a 3,000-entry transcript that has been painted once
		const { transcript, entries } = hydratedTranscript(HISTORY);
		const first = transcript.render(WIDTH);
		const before = entries.map((entry) => entry.renders);

		// When: 50 more frames are painted, as typing in the editor does
		let frame: string[] = first;
		for (let keystroke = 0; keystroke < 50; keystroke++) frame = transcript.render(WIDTH);

		// Then: no history entry was rendered again and the transcript looks identical
		expect(rendersSince(entries, before)).toBe(0);
		expect(frame).toStrictEqual(first);
	});

	it("streams a live reply without re-rendering the history above it", () => {
		// Given: a painted huge transcript and a reply that is still streaming
		const { transcript, entries } = hydratedTranscript(HISTORY);
		transcript.render(WIDTH);
		const reply = new Text("", 1, 0);
		transcript.addChild(reply);
		const before = entries.map((entry) => entry.renders);

		// When: 30 streamed deltas each paint a frame, as a background-triggered turn does
		let frame: string[] = [];
		for (let delta = 1; delta <= 30; delta++) {
			reply.setText(`word `.repeat(delta).trim());
			frame = transcript.render(WIDTH);
		}

		// Then: only the reply changed and the history was never rendered again
		expect(rendersSince(entries, before)).toBe(0);
		const replyLines = reply.render(WIDTH).length;
		const shown = frame
			.slice(-replyLines)
			.map((line) => line.trim())
			.join(" ");
		expect(shown).toBe("word ".repeat(30).trim());
	});
});

describe("cached history never shows stale content", () => {
	it("shows an edited entry far above the viewport on the next frame", () => {
		// Given: a painted huge transcript
		const { transcript, entries } = hydratedTranscript(HISTORY);
		transcript.render(WIDTH);

		// When: an early entry changes (an expanded card, a late tool result)
		const before = entries.map((entry) => entry.renders);
		entries[7]!.setText("**Entry 7**: EXPANDED DETAILS");
		const frame = transcript.render(WIDTH);

		// Then: the change is visible, only that entry was rendered again, and the rest stay in place
		expect(frame.some((line) => line.includes("EXPANDED DETAILS"))).toBe(true);
		expect(rendersSince(entries, before)).toBe(1);
		expect(frame.filter((line) => line.includes(`Entry ${HISTORY - 1}`))).toHaveLength(1);
	});

	it("repaints every entry with the new palette after a theme change", () => {
		// Given: a painted transcript
		const { transcript, entries } = hydratedTranscript(200);
		transcript.render(WIDTH);
		const before = entries.map((entry) => entry.renders);

		// When: the theme changes, which invalidates the whole tree
		transcript.invalidate();
		transcript.render(WIDTH);

		// Then: every entry was rendered again rather than served from the old cache
		expect(entries.every((entry, index) => entry.renders > (before[index] ?? 0))).toBe(true);
	});

	it("rewraps history for a new terminal width", () => {
		// Given: a transcript painted at a wide width
		const { transcript } = hydratedTranscript(50);
		const wide = transcript.render(WIDTH);

		// When: the terminal narrows
		const narrow = transcript.render(20);

		// Then: lines fit the new width and the content wrapped onto more lines
		expect(narrow.length).toBeGreaterThan(wide.length);
		expect(narrow.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length <= 20)).toBe(true);
	});

	it("keeps updating a component that cannot report a revision", () => {
		// Given: a transcript with an extension component that changes on its own
		const { transcript } = hydratedTranscript(500);
		const clock = new UnrevisionedClock();
		transcript.addChild(clock);
		transcript.render(WIDTH);

		// When: two more frames are painted
		transcript.render(WIDTH);
		const frame = transcript.render(WIDTH);

		// Then: its newest output is shown every frame
		expect(frame.at(-1)).toBe("tick 3");
	});

	it("shows an entry inserted into the middle of the history", () => {
		// Given: a painted transcript
		const { transcript } = hydratedTranscript(400);
		transcript.render(WIDTH);

		// When: a card is inserted before an existing entry (a late assistant segment)
		const inserted = new Container();
		inserted.addChild(new Text("INSERTED SEGMENT", 0, 0));
		transcript.children.splice(100, 0, inserted);
		const frame = transcript.render(WIDTH);

		// Then: it appears exactly between its neighbours
		const at = frame.findIndex((line) => line.includes("INSERTED SEGMENT"));
		const previous = frame.findLastIndex((line, index) => index < at && line.includes("Entry 99"));
		const next = frame.findIndex((line, index) => index > at && line.includes("Entry 100"));
		expect(at).toBeGreaterThan(previous);
		expect(previous).toBeGreaterThan(-1);
		expect(next).toBeGreaterThan(at);
	});
});
