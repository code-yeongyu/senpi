import { Container, ProcessTerminal, resetCapabilitiesCache, setCapabilities, Text, TUI } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import * as imageConvert from "../../src/utils/image-convert.ts";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(() => {
	vi.restoreAllMocks();
	resetCapabilitiesCache();
});

it("advances the idle document revision when a deferred tool image becomes renderable", async () => {
	initTheme("dark");
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const conversion = Promise.withResolvers<Awaited<ReturnType<typeof imageConvert.convertToPng>>>();
	vi.spyOn(imageConvert, "convertToPng").mockReturnValueOnce(conversion.promise);
	const ui = new TUI(new ProcessTerminal());
	const requestRender = vi.spyOn(ui, "requestRender").mockImplementation(() => {});
	const card = new ToolExecutionComponent(
		"image_fixture",
		"image-call",
		{},
		{ showImages: true },
		{ renderResult: () => new Text("completed synthetic image tool", 0, 0) },
		ui,
		process.cwd(),
	);
	const chat = new ExplorationTranscriptContainer({ tailBudget: 60, warmChunkSize: 100, requestRender() {} });
	chat.addChild(card);
	try {
		card.updateResult({
			content: [{ type: "image", data: Buffer.from("deferred fixture").toString("base64"), mimeType: "image/jpeg" }],
			details: undefined,
			isError: false,
		});
		expect(chat.render(80).join("\n")).not.toContain("\x1b_G");
		const state = {
			chatContainer: chat,
			headerContainer: new Container(),
			loadedResourcesContainer: new Container(),
			pendingTools: new Map(),
			session: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0 },
			workingRegionRevision: 0,
			workingRegionSnapshot: undefined,
			builtInHeader: new Text("header", 0, 0),
			ui,
		};
		state.headerContainer.addChild(state.builtInHeader);
		const readRevision = (): number | undefined =>
			Reflect.get(InteractiveMode.prototype, "getWorkingRegionRevision").call(state, true);
		const committed = readRevision();
		expect(committed).toBeTypeOf("number");
		requestRender.mockClear();

		conversion.resolve({ data: ONE_PIXEL_PNG, mimeType: "image/png" });
		await conversion.promise;

		// Conversion really completed and requested a frame; this is not a failed-image fixture.
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(card.render(80).join("\n")).toContain("\x1b_G");
		const changed = readRevision();
		expect(changed).toBeTypeOf("number");
		expect(changed).toBeGreaterThan(committed!);
	} finally {
		chat.dispose();
	}
});
