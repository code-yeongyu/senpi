import { type Component, Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../../src/modes/interactive/interactive-mode.ts";

describe("fullscreen transcript exit", () => {
	it.each(["transcript", "resume-hint"] as const)(
		"materializes cold indexed history only for %s output",
		async (output) => {
			const requestRender = vi.fn();
			const chatContainer = new ExplorationTranscriptContainer({
				tailBudget: 60,
				warmChunkSize: 100,
				requestRender,
			});
			const lines = Array.from({ length: 120 }, (_, index) => `transcript-entry-${index}`);
			const renders = lines.map((line) => vi.fn(() => [line]));
			for (const render of renders) chatContainer.addChild({ render, invalidate() {} } satisfies Component);
			const source = chatContainer.createScrollEntrySource();
			source.get(source.length - 1).component.render(80);
			expect(chatContainer.isFullyHydrated).toBe(false);
			expect(renders[0]).not.toHaveBeenCalled();

			const terminal = new VirtualTerminal(80, 24);
			const renderer = createInteractiveTui({
				tuiMode: "fullscreen",
				showHardwareCursor: false,
				logDirectory: "/tmp",
				terminal,
			});
			const documentContainer = new Container();
			documentContainer.addChild(chatContainer);
			renderer.addChild(documentContainer);
			const context = Object.assign(Object.create(InteractiveMode.prototype), {
				renderer,
				chatContainer,
				documentContainer,
				options: { tuiMode: "fullscreen" },
				pauseQuestionMouseCapture: vi.fn(),
				getWorkingRegionRevision: () => undefined,
			});
			context.ui = createInteractiveTuiReference(() => context.renderer);
			try {
				Reflect.get(InteractiveMode.prototype, "stopInteractiveTui").call(context, output);
				await terminal.flush();
				const printed = terminal
					.getScrollBuffer()
					.filter((line) => line.startsWith("transcript-entry-"))
					.map((line) => line.trimEnd());
				expect(printed).toEqual(output === "transcript" ? lines : []);
				expect(renders[0]).toHaveBeenCalledTimes(output === "transcript" ? 1 : 0);
				expect(requestRender).not.toHaveBeenCalled();
			} finally {
				chatContainer.dispose();
				context.renderer.stop({ preserveScreen: true });
			}
		},
	);
});
