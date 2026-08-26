import type { Context, ImageContent as ImageBlock, ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { FauxModelDefinition } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import lookAtExtension from "../../src/core/extensions/builtin/look-at/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * End-to-end proof that a PASTED attachment is resolvable by `look_at` with
 * ZERO production change to the look_at extension: the interactive submission
 * path turns `[Image #N]` markers into the `images` array, `AgentSession`
 * stores that array on the user message, and look_at's `lastUserImages` finds
 * it back by position.
 *
 * The images array under test is built by the REAL production helper
 * (`InteractiveMode#takeSubmissionImages`), never hand-assembled here, so the
 * position invariant "the Nth marker is images[N-1]" is asserted against
 * production ordering and fails if that ordering is broken.
 */

const TOOL_NAME = "look_at";

/** 1x1 PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
/** 1x1 JPEG - deliberately a different MIME type and byte string than the PNG. */
const JPEG_BASE64 =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ap//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";

const harnesses: Harness[] = [];

function textOnly(id: string): FauxModelDefinition {
	return { id, input: ["text"] };
}

function vision(id: string): FauxModelDefinition {
	return { id, input: ["text", "image"] };
}

type SubmissionReceiver = { pendingImages: Map<number, ImageContent> };

const takeSubmissionImages = (
	InteractiveMode.prototype as unknown as {
		takeSubmissionImages(this: SubmissionReceiver, submittedText: string): ImageContent[];
	}
).takeSubmissionImages;

/**
 * Resolve markers into the submitted `images` array through the production
 * helper, exactly as the editor submit path does: `pendingImages` is keyed by
 * marker id and the helper walks the submitted text in reading order.
 */
function submissionImages(submittedText: string, pending: ReadonlyArray<[number, ImageContent]>): ImageContent[] {
	const receiver: SubmissionReceiver = { pendingImages: new Map(pending) };
	return takeSubmissionImages.call(receiver, submittedText);
}

function pastedImage(data: string, mimeType: string): ImageContent {
	return { type: "image", data, mimeType };
}

async function createLookAtHarness(models: FauxModelDefinition[] = [textOnly("main"), vision("vision")]) {
	const harness = await createHarness({
		models,
		settings: { images: { autoResize: false } },
		extensionFactories: [lookAtExtension],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return harness;
}

/**
 * Send one user turn exactly the way the interactive submission channel does:
 * the marker text stays literal in the message and the resolved attachments
 * ride `PromptOptions.images`.
 */
async function sendPastedTurn(harness: Harness, text: string, images: ImageContent[]): Promise<void> {
	harness.setResponses([fauxAssistantMessage("acknowledged")]);
	await harness.session.prompt(text, { images });
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** The media the vision model actually received on the last look_at request. */
function lastVisionRequest(harness: Harness): { images: ImageBlock[]; text: string } {
	const call = harness.faux.getCallLog().at(-1);
	if (!call) throw new Error("No faux provider call was recorded.");
	expect(call.modelId).toBe("vision");
	const context: Context = call.context;
	const content = context.messages.at(-1)?.content;
	if (!Array.isArray(content)) throw new Error("Vision request had no structured content.");
	return {
		images: content.filter((block): block is ImageBlock => block.type === "image"),
		text: content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n"),
	};
}

async function lookAt(harness: Harness, filePath: string) {
	harness.setResponses([fauxAssistantMessage("vision analysis")]);
	return harness.session.executeTool<{ model: string; sources: string[]; mimeTypes: string[] }>(TOOL_NAME, {
		file_path: filePath,
		goal: "Describe the attachment",
	});
}

describe("look_at resolution of pasted image attachments", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("resolves the pasted [Image #1] marker to the attachment's own bytes", async () => {
		const harness = await createLookAtHarness();
		const pasted = pastedImage(PNG_BASE64, "image/png");
		const images = submissionImages("describe [Image #1]", [[1, pasted]]);
		expect(images).toEqual([pasted]);
		await sendPastedTurn(harness, "describe [Image #1]", images);

		const result = await lookAt(harness, "[Image #1]");

		expect(resultText(result)).toBe("vision analysis");
		expect(result.details).toEqual({ model: "faux/vision", sources: ["Image #1"], mimeTypes: ["image/png"] });
		const request = lastVisionRequest(harness);
		expect(request.images).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
		expect(request.text).toContain("- Image #1");
	});

	it("resolves attachment://1 to the same pasted attachment", async () => {
		const harness = await createLookAtHarness();
		const pasted = pastedImage(PNG_BASE64, "image/png");
		await sendPastedTurn(harness, "describe [Image #1]", submissionImages("describe [Image #1]", [[1, pasted]]));

		const result = await lookAt(harness, "attachment://1");

		expect(result.details).toEqual({ model: "faux/vision", sources: ["Image #1"], mimeTypes: ["image/png"] });
		expect(lastVisionRequest(harness).images).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("reports the available attachments when the referenced index does not exist", async () => {
		const harness = await createLookAtHarness();
		const pasted = pastedImage(PNG_BASE64, "image/png");
		await sendPastedTurn(harness, "describe [Image #1]", submissionImages("describe [Image #1]", [[1, pasted]]));

		harness.setResponses([fauxAssistantMessage("must not be reached")]);
		const result = await harness.session.executeTool(TOOL_NAME, {
			file_path: "[Image #2]",
			goal: "Describe the attachment",
		});

		expect(resultText(result)).toContain("Could not resolve image attachment '[Image #2]'");
		expect(resultText(result)).toContain("Available image attachments: Image #1 -> attachment://1.");
		expect(harness.faux.getCallLog().filter((call) => call.modelId === "vision")).toHaveLength(0);
	});

	it("maps [Image #2] onto the SECOND submitted attachment (position invariant)", async () => {
		const harness = await createLookAtHarness();
		const first = pastedImage(PNG_BASE64, "image/png");
		const second = pastedImage(JPEG_BASE64, "image/jpeg");
		const text = "compare [Image #1] with [Image #2]";
		const images = submissionImages(text, [
			[1, first],
			[2, second],
		]);
		await sendPastedTurn(harness, text, images);

		const result = await lookAt(harness, "[Image #2]");

		expect(result.details).toEqual({ model: "faux/vision", sources: ["Image #2"], mimeTypes: ["image/jpeg"] });
		expect(lastVisionRequest(harness).images).toEqual([{ type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" }]);
	});

	it("keeps the reference turn-local: markers point at the latest user message only", async () => {
		const harness = await createLookAtHarness();
		const older = pastedImage(PNG_BASE64, "image/png");
		const newer = pastedImage(JPEG_BASE64, "image/jpeg");
		await sendPastedTurn(harness, "describe [Image #1]", submissionImages("describe [Image #1]", [[1, older]]));
		await sendPastedTurn(
			harness,
			"now describe [Image #1]",
			submissionImages("now describe [Image #1]", [[1, newer]]),
		);

		const result = await lookAt(harness, "[Image #1]");

		expect(result.details?.mimeTypes).toEqual(["image/jpeg"]);
		expect(lastVisionRequest(harness).images).toEqual([{ type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" }]);
	});

	it("activates look_at for a text-only model and deactivates it for a vision model", async () => {
		const gated = await createLookAtHarness();
		expect(gated.session.getActiveToolNames()).toContain(TOOL_NAME);

		const visionModel = gated.getModel("vision");
		if (!visionModel) throw new Error("Missing vision model in the faux registry.");
		await gated.session.setModel(visionModel);
		expect(gated.session.getActiveToolNames()).not.toContain(TOOL_NAME);

		const withoutVision = await createLookAtHarness([textOnly("main")]);
		expect(withoutVision.session.getActiveToolNames()).not.toContain(TOOL_NAME);
	});
});
