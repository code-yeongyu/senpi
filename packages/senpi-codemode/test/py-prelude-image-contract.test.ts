import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { marshalToolResult } from "../src/tool/image.ts";
import { hasPython3, runCell } from "./py-kernel/fixtures.ts";

const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82] as const;
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
const JPEG_BASE64 = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString("base64");

function displays(
	messages: readonly KernelToHostMessage[],
): readonly Extract<KernelToHostMessage, { type: "display" }>[] {
	return messages.filter(
		(message): message is Extract<KernelToHostMessage, { type: "display" }> => message.type === "display",
	);
}

function stdout(messages: readonly KernelToHostMessage[]): string {
	return messages
		.flatMap((message) => (message.type === "text" && message.stream === "stdout" ? [message.data] : []))
		.join("");
}

async function startPython(
	port: number,
	token: string,
	onMessage: (message: KernelToHostMessage) => void,
): Promise<PythonKernel> {
	const detected = await createInterpreterDetector().detect("py");
	if (!detected.ok) throw new Error("python unavailable");
	return await PythonKernel.start({
		interpreterPath: detected.path,
		sessionId: `py-image-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		connection: { port, token },
		onMessage,
	});
}

const imageReadReply = marshalToolResult({
	content: [
		{ type: "text", text: "Read image file [image/png]" },
		{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
	],
	details: {},
});

describe.skipIf(!(await hasPython3()))("Python prelude image contract", () => {
	it("Given a tool.read image reply when display runs on images[0] then the image frame is emitted", async () => {
		// Given
		const messages: KernelToHostMessage[] = [];
		const server = await startBridgeServer({
			token: "image-token",
			onCall: async () => imageReadReply,
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		const kernel = await startPython(server.port, server.token, (message) => messages.push(message));

		try {
			// When
			const result = await runCell(
				kernel,
				["r = tool.read({'path': 'shot.png'})", "display(r['images'][0])", "print(r['text'])"].join("\n"),
			);

			// Then
			expect(result.ok).toBe(true);
			expect(displays(messages)).toEqual([{ type: "display", mimeType: "image/png", dataBase64: PNG_BASE64 }]);
			expect(stdout(messages)).toContain("Read image file [image/png]");
		} finally {
			await kernel.close();
			await server.close();
		}
	});

	it("Given the whole marshalled reply when display runs then text is printed and images are promoted", async () => {
		// Given
		const messages: KernelToHostMessage[] = [];
		const server = await startBridgeServer({
			token: "image-token",
			onCall: async () => imageReadReply,
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		const kernel = await startPython(server.port, server.token, (message) => messages.push(message));

		try {
			// When
			const result = await runCell(kernel, "display(tool.read({'path': 'shot.png'}))");

			// Then
			expect(result.ok).toBe(true);
			expect(displays(messages)).toEqual([{ type: "display", mimeType: "image/png", dataBase64: PNG_BASE64 }]);
			expect(stdout(messages)).toContain("Read image file [image/png]");
			expect(stdout(messages)).not.toContain(PNG_BASE64);
		} finally {
			await kernel.close();
			await server.close();
		}
	});

	it.each([
		["png", PNG_BASE64, "image/png"],
		["jpeg", JPEG_BASE64, "image/jpeg"],
	] as const)(
		"Given raw %s bytes when display runs then the sniffed mime type is emitted",
		async (_name, base64, mimeType) => {
			// Given
			const messages: KernelToHostMessage[] = [];
			const kernel = await startPython(1, "unused", (message) => messages.push(message));

			try {
				// When
				const result = await runCell(kernel, `import base64\ndisplay(base64.b64decode(${JSON.stringify(base64)}))`);

				// Then
				expect(result.ok).toBe(true);
				expect(displays(messages)).toEqual([{ type: "display", mimeType, dataBase64: base64 }]);
			} finally {
				await kernel.close();
			}
		},
	);

	it("Given non-image bytes when display runs then they stay an octet-stream", async () => {
		// Given
		const messages: KernelToHostMessage[] = [];
		const kernel = await startPython(1, "unused", (message) => messages.push(message));

		try {
			// When
			const result = await runCell(kernel, "display(b'binary')");

			// Then
			expect(result.ok).toBe(true);
			expect(displays(messages).map((message) => message.mimeType)).toEqual(["application/octet-stream"]);
		} finally {
			await kernel.close();
		}
	});
});
