import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { marshalToolResult } from "../src/tool/image.ts";
import { runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";
import { hasPython3, runCell } from "./py-kernel/fixtures.ts";

// A screenshot-sized PNG payload: the 8-byte signature plus ~300 KB of pixel bytes (omo#12185 measured ~440 KB of text).
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const PIXEL_BYTES = 300_000;
const SCREENSHOT_BASE64 = Buffer.concat([Buffer.from(PNG_SIGNATURE), Buffer.alloc(PIXEL_BYTES, 7)]).toString("base64");
const JS_SCREENSHOT = `Buffer.concat([Buffer.from([${PNG_SIGNATURE.join(",")}]), Buffer.alloc(${PIXEL_BYTES}, 7)]).toString("base64")`;
// Longest base64-alphabet run any text output may carry; a real image payload is orders of magnitude longer.
const MAX_BASE64_RUN = 200;
const PYTHON_AVAILABLE = await hasPython3();

function imageFrames(messages: readonly KernelToHostMessage[]): readonly { mimeType: string; dataBase64: string }[] {
	return messages.flatMap((message) =>
		message.type === "display" && message.mimeType.startsWith("image/")
			? [{ mimeType: message.mimeType, dataBase64: message.dataBase64 }]
			: [],
	);
}

function textOutput(messages: readonly KernelToHostMessage[]): string {
	return messages
		.flatMap((message) => {
			if (message.type === "text") return [message.data];
			if (message.type === "result" && message.ok && message.valueRepr !== undefined) return [message.valueRepr];
			if (message.type === "display" && !message.mimeType.startsWith("image/")) {
				return [Buffer.from(message.dataBase64, "base64").toString("utf8")];
			}
			return [];
		})
		.join("\n");
}

function longestBase64Run(text: string): number {
	return Math.max(0, ...Array.from(text.matchAll(/[A-Za-z0-9+/=]+/gu), (match) => match[0].length));
}

const screenshotReply = marshalToolResult({
	content: [
		{ type: "text", text: "screenshot desktop 1280x720" },
		{ type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" },
	],
	details: { width: 1280, height: 720 },
});

describe("eval cell values carrying images (omo#12185)", () => {
	describe("JavaScript kernel", () => {
		const replyExpression = `{ text: "screenshot desktop 1280x720", details: { width: 1280, height: 720 }, images: [{ mimeType: "image/png", dataBase64: ${JS_SCREENSHOT} }], hasError: false }`;

		it.each([
			["returns", `return ${replyExpression};`],
			["prints", `print(${replyExpression});`],
			["logs", `console.log(${replyExpression});`],
			["displays a wrapper of", `display({ shot: ${replyExpression} });`],
		] as const)(
			"Given a cell that %s a tool result when it settles then the image is an image frame, not text",
			async (_verb, code) => {
				await withJavaScriptKernel(async (kernel) => {
					// When
					const run = await runJavaScriptCell(kernel, code, 20_000);
					const messages = [...run.messages, run.result];

					// Then
					expect(run.result.ok).toBe(true);
					expect(imageFrames(messages)).toEqual([{ mimeType: "image/png", dataBase64: SCREENSHOT_BASE64 }]);
					expect(longestBase64Run(textOutput(messages))).toBeLessThan(MAX_BASE64_RUN);
					expect(textOutput(messages)).toContain("screenshot desktop 1280x720");
				});
			},
		);

		it("Given a returned tool result when it settles then its other fields stay in the value text", async () => {
			await withJavaScriptKernel(async (kernel) => {
				// When
				const run = await runJavaScriptCell(kernel, `return ${replyExpression};`, 20_000);

				// Then
				expect(run.result.ok).toBe(true);
				const value: unknown = JSON.parse(run.result.ok ? (run.result.valueRepr ?? "null") : "null");
				expect(value).toMatchObject({
					text: "screenshot desktop 1280x720",
					details: { width: 1280, height: 720 },
					hasError: false,
				});
				expect(value).toHaveProperty(["images", 0, "mimeType"], "image/png");
				expect(value).toHaveProperty(["images", 0, "dataBase64"], expect.stringContaining("attached"));
			});
		});

		it("Given a returned value with no image when it settles then the value text is unchanged", async () => {
			await withJavaScriptKernel(async (kernel) => {
				// When
				const run = await runJavaScriptCell(
					kernel,
					`return { mimeType: "text/plain", dataBase64: "aGk=", nested: [1, { a: "b" }] };`,
				);

				// Then
				expect(run.result.ok && run.result.valueRepr).toBe(
					JSON.stringify({ mimeType: "text/plain", dataBase64: "aGk=", nested: [1, { a: "b" }] }),
				);
				expect(imageFrames(run.messages)).toEqual([]);
			});
		});
	});

	describe.skipIf(!PYTHON_AVAILABLE)("Python kernel", () => {
		it.each([
			["returns", "tool.computer({'action': 'screenshot'})"],
			["prints", "print(tool.computer({'action': 'screenshot'}))"],
			["displays a wrapper of", "display({'shot': tool.computer({'action': 'screenshot'})})"],
		] as const)(
			"Given a cell that %s a tool result when it settles then the image is an image frame, not text",
			async (_verb, code) => {
				// Given
				const messages: KernelToHostMessage[] = [];
				const server = await startBridgeServer({
					token: "image-token",
					onCall: async () => screenshotReply,
					onEmit: async () => {},
					onCompletion: async () => "unused",
				});
				const detected = await createInterpreterDetector().detect("py");
				if (!detected.ok) throw new Error("python unavailable");
				const kernel = await PythonKernel.start({
					interpreterPath: detected.path,
					sessionId: `py-value-image-${crypto.randomUUID()}`,
					cwd: process.cwd(),
					connection: { port: server.port, token: server.token },
					onMessage: (message) => messages.push(message),
				});

				try {
					// When
					const result = await runCell(kernel, code);
					const all = [...messages, result];

					// Then
					expect(result.ok).toBe(true);
					expect(imageFrames(all)).toEqual([{ mimeType: "image/png", dataBase64: SCREENSHOT_BASE64 }]);
					expect(longestBase64Run(textOutput(all))).toBeLessThan(MAX_BASE64_RUN);
					expect(textOutput(all)).toContain("screenshot desktop 1280x720");
				} finally {
					await kernel.close();
					await server.close();
				}
			},
		);
	});
});
