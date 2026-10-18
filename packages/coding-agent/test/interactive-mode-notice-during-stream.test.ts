import { Container, Text, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Regression #2836: `/todo` (any info notice) posted while a turn streams was appended after the live
 * assistant message. A notice taller than the viewport pushed the live tail above it, so every streamed
 * delta changed rows above the viewport and the renderer replayed the whole scrollback (ESC[3J + full
 * rewrite) per token, which an xterm.js host shows as the view jumping to the top again and again.
 */
const showStatus = Reflect.get(InteractiveMode.prototype, "showStatus") as (this: StatusHost, message: string) => void;

interface StatusHost {
	chatContainer: Container;
	streamingComponent: Text | undefined;
	lastStatusText?: unknown;
	lastStatusSpacer?: unknown;
	lastStatusMessage?: string;
	ui: TUI;
}

class CountingTerminal extends VirtualTerminal {
	scrollbackClears = 0;
	override write(data: string): void {
		this.scrollbackClears += data.split("\x1b[3J").length - 1;
		super.write(data);
	}

	private get emulator(): XtermLike {
		return Reflect.get(this, "xterm") as XtermLike;
	}

	/** The user scrolls the terminal's own view up by `lines`, as with the mouse wheel. */
	scrollUp(lines: number): void {
		this.emulator.scrollLines(-lines);
	}

	/** The text of the top row the user is looking at. */
	topVisibleRow(): string {
		const buffer = this.emulator.buffer.active;
		return buffer.getLine(buffer.viewportY)?.translateToString(true) ?? "";
	}
}

interface XtermLike {
	scrollLines(amount: number): void;
	buffer: {
		active: { viewportY: number; getLine(row: number): { translateToString(trim: boolean): string } | undefined };
	};
}

function streamingHost() {
	const terminal = new CountingTerminal(80, 20);
	const ui = new TUI(terminal);
	const chatContainer = new Container();
	for (let index = 0; index < 30; index++) chatContainer.addChild(new Text(`earlier line ${index}`, 0, 0));
	const streamed: string[] = ["assistant: starting"];
	const live = new Text(streamed.join("\n"), 0, 0);
	chatContainer.addChild(live);
	ui.addChild(chatContainer);
	ui.addChild(new Text("> editor", 0, 0));
	const host: StatusHost = { chatContainer, streamingComponent: live, ui };
	const stream = (line: string) => {
		streamed.push(line);
		live.setText(streamed.join("\n"));
		ui.renderNow();
	};
	return { terminal, ui, host, live, stream };
}

const tallTodo = Array.from({ length: 40 }, (_, index) => `- [ ] task ${index}`).join("\n");

describe("#2836 a notice posted while a turn streams", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("does not push the live output off the screen or replay the scrollback per streamed delta", async () => {
		const { terminal, ui, host, stream } = streamingHost();
		ui.start();
		ui.renderNow();
		stream("assistant: first delta");

		showStatus.call(host, tallTodo);
		ui.renderNow();
		const clearsAfterNotice = terminal.scrollbackClears;
		for (let index = 0; index < 5; index++) stream(`assistant: delta ${index}`);

		expect(terminal.scrollbackClears - clearsAfterNotice).toBe(0);
		const viewport = (await terminal.flushAndGetViewport()).join("\n");
		expect(viewport).toContain("assistant: delta 4");
		const transcript = host.chatContainer.render(80).join("\n");
		expect(transcript).toContain("task 39");
		expect(transcript.indexOf("task 39")).toBeLessThan(transcript.indexOf("assistant: delta 4"));
		ui.stop();
	});

	test("a user scrolled up into the history keeps looking at the same rows while a notice and more output arrive", async () => {
		const { terminal, ui, host, stream } = streamingHost();
		ui.start();
		ui.renderNow();
		stream("assistant: first delta");
		await terminal.flush();
		terminal.scrollUp(8);
		const watching = terminal.topVisibleRow();
		expect(watching).toContain("earlier line");

		showStatus.call(host, tallTodo);
		ui.renderNow();
		for (let index = 0; index < 5; index++) stream(`assistant: delta ${index}`);
		await terminal.flush();

		expect(terminal.topVisibleRow()).toBe(watching);
		ui.stop();
	});

	test("a second notice during the same turn replaces the first in place, above the live message", () => {
		const { ui, host, stream } = streamingHost();
		ui.renderNow();
		showStatus.call(host, "first notice");
		stream("assistant: more");
		showStatus.call(host, "second notice");
		const transcript = host.chatContainer.render(80).join("\n");
		expect(transcript).not.toContain("first notice");
		expect(transcript.split("second notice").length - 1).toBe(1);
		expect(transcript.indexOf("second notice")).toBeLessThan(transcript.indexOf("assistant: more"));
		ui.stop();
	});

	test("an idle notice still lands at the end of the transcript", () => {
		const { ui, host } = streamingHost();
		host.streamingComponent = undefined;
		showStatus.call(host, "Todos unchanged.");
		const children = host.chatContainer.children;
		expect((children[children.length - 1] as Text).render(80).join("\n")).toContain("Todos unchanged.");
		ui.stop();
	});
});
