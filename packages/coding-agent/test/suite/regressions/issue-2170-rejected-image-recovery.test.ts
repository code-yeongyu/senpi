import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#2170: one provider-rejected image must not poison every later turn.
const WINDOWS_PATH = "C:\\Users\\<user>\\Pictures\\Screenshots\\aaa.png";
const CODEX_INVALID_IMAGE =
	"Codex error: The image data you provided does not represent a valid image. Please check your input and try again with one of the supported image formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].";
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const OTHER_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const readTool: AgentTool = {
	name: "read",
	label: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async (_id, params) => ({
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{
				type: "image",
				data: (params as { path: string }).path === WINDOWS_PATH ? TINY_PNG_BASE64 : OTHER_PNG_BASE64,
				mimeType: "image/png",
			},
		],
		details: {},
	}),
};

function imageData(context: Context): string[] {
	return context.messages.flatMap((message) =>
		message.role !== "assistant" && Array.isArray(message.content)
			? message.content.flatMap((block) => (block.type === "image" ? [block.data] : []))
			: [],
	);
}

function textOf(context: Context): string {
	return JSON.stringify(context.messages);
}

function rejectBadImage(requests: Context[], reply: string): FauxResponseFactory {
	return (context) => {
		requests.push({ messages: structuredClone(context.messages) });
		return imageData(context).includes(TINY_PNG_BASE64)
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: CODEX_INVALID_IMAGE })
			: fauxAssistantMessage(reply);
	};
}

describe("senpi#2170 provider-rejected image recovery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("drops the rejected image, names the file, and lets the next text-only turn through", async () => {
		const harness = await createHarness({ tools: [readTool], persistSession: true });
		harnesses.push(harness);
		const requests: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: WINDOWS_PATH })], { stopReason: "toolUse" }),
			rejectBadImage(requests, "unreachable"),
			rejectBadImage(requests, "recovered"),
		]);

		await harness.session.prompt(`look at ${WINDOWS_PATH}`);
		const failed = harness.session.messages.at(-1);
		expect(failed).toMatchObject({ role: "assistant", stopReason: "error" });
		expect((failed as { errorMessage?: string }).errorMessage).toContain(WINDOWS_PATH);

		await harness.session.prompt("it is a png, why does it not work?");

		const followUp = requests.at(-1);
		expect(followUp).toBeDefined();
		expect(imageData(followUp as Context)).toEqual([]);
		expect(textOf(followUp as Context)).toContain("Image omitted: the provider rejected this image");
		expect(textOf(followUp as Context)).toContain(JSON.stringify(WINDOWS_PATH).slice(1, -1));
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopened = SessionManager.open(sessionFile as string).buildSessionContext().messages;
		const replay = convertToLlm(reopened);
		expect(imageData({ messages: replay })).toEqual([]);
		expect(textOf({ messages: replay })).toContain("Image omitted: the provider rejected this image");
	});

	it("keeps images an earlier successful response already accepted", async () => {
		const harness = await createHarness({ tools: [readTool] });
		harnesses.push(harness);
		const requests: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "C:\\ok.png" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("saw the first image"),
			fauxAssistantMessage([fauxToolCall("read", { path: WINDOWS_PATH })], { stopReason: "toolUse" }),
			rejectBadImage(requests, "unreachable"),
			rejectBadImage(requests, "recovered"),
		]);

		await harness.session.prompt("read the ok image");
		await harness.session.prompt("now read the screenshot");
		await harness.session.prompt("continue");

		expect(imageData(requests.at(-1) as Context)).toEqual([OTHER_PNG_BASE64]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("keeps images when the failure is not an image rejection", async () => {
		const harness = await createHarness({ tools: [readTool] });
		harnesses.push(harness);
		const requests: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "C:\\ok.png" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Codex error: invalid_request: tool schema mismatch",
			}),
			(context) => {
				requests.push({ messages: structuredClone(context.messages) });
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("read the ok image");
		await harness.session.prompt("try again");

		expect(imageData(requests.at(-1) as Context)).toEqual([OTHER_PNG_BASE64]);
	});
});
