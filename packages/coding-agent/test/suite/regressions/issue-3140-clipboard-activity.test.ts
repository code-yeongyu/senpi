import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

const clipboard = vi.hoisted(() => ({ image: vi.fn() }));
vi.mock("../../../src/utils/clipboard-image.ts", async (original) => ({
	...(await original<typeof import("../../../src/utils/clipboard-image.ts")>()),
	readClipboardImage: clipboard.image,
}));
vi.mock("../../../src/utils/clipboard.ts", async (original) => ({
	...(await original<typeof import("../../../src/utils/clipboard.ts")>()),
	readClipboardFilePaths: vi.fn(async () => null),
	readClipboardText: vi.fn(async () => null),
}));

describe("clipboard activity follows actual attachment (#3140)", () => {
	afterEach(() => vi.clearAllMocks());

	it.each([true, false])("publishes only inserted images when compacting=%s", async (isCompacting) => {
		const activity = vi.fn();
		const receiver = {
			session: { isCompacting, recordUserActivity: activity },
			editor: { insertImageMarker: vi.fn(() => 1) },
			pendingImages: new Map<number, ImageContent>(),
			settingsManager: { getBlockImages: () => false, getImageAutoResize: () => false },
			showStatus: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		clipboard.image.mockResolvedValue({
			bytes: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mN4YGBAEmIY1TCqYfhqAADPxkAQTDYcEAAAAABJRU5ErkJggg==",
				"base64",
			),
			mimeType: "image/png",
		});
		const paste: ((this: typeof receiver) => Promise<void>) | undefined = Object.getOwnPropertyDescriptor(
			InteractiveMode.prototype,
			"handleClipboardPaste",
		)?.value;
		if (paste === undefined) throw new Error("Missing clipboard paste handler");

		await paste.call(receiver);

		expect(activity).toHaveBeenCalledTimes(isCompacting ? 0 : 1);
		expect(receiver.editor.insertImageMarker).toHaveBeenCalledTimes(isCompacting ? 0 : 1);
		expect(receiver.showStatus).toHaveBeenCalledTimes(isCompacting ? 1 : 0);
	});
});
