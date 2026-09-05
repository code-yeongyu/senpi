import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { marshalToolResult } from "../src/tool/image.ts";
import { runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82] as const;
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
const JPEG_BASE64 = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString("base64");
const GIF_BASE64 = Buffer.from("GIF89a-frame", "binary").toString("base64");

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

describe("eval image contract", () => {
	it("Given a marshalled tool result when display runs then its images reach the model", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given a value shaped exactly like `await tool.read({ path: "shot.png" })`.
			const reply = marshalToolResult({
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
				],
				details: {},
			});
			const code = `display(${JSON.stringify(reply)});`;

			// When
			const run = await runJavaScriptCell(kernel, code);

			// Then the image is promoted, not JSON-dumped with the base64 inline.
			expect(displays(run.messages)).toEqual([{ type: "display", mimeType: "image/png", dataBase64: PNG_BASE64 }]);
			expect(stdout(run.messages)).not.toContain(PNG_BASE64);
		});
	});

	it("Given a marshalled result carrying text when display runs then the text is kept as output", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const reply = marshalToolResult({
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
				],
				details: {},
			});

			// When
			const run = await runJavaScriptCell(kernel, `display(${JSON.stringify(reply)});`);

			// Then
			expect(stdout(run.messages)).toContain("Read image file [image/png]");
		});
	});

	it.each([
		["png", `new Uint8Array([${PNG_BYTES.join(",")}])`, "image/png", PNG_BASE64],
		["jpeg", `Buffer.from(${JSON.stringify(JPEG_BASE64)}, "base64")`, "image/jpeg", JPEG_BASE64],
		["gif", `Buffer.from(${JSON.stringify(GIF_BASE64)}, "base64")`, "image/gif", GIF_BASE64],
	] as const)(
		"Given raw %s bytes when display runs then the sniffed mime type is emitted",
		async (_name, expression, mimeType, dataBase64) => {
			await withJavaScriptKernel(async (kernel) => {
				// When
				const run = await runJavaScriptCell(kernel, `display(${expression});`);

				// Then
				expect(displays(run.messages)).toEqual([{ type: "display", mimeType, dataBase64 }]);
			});
		},
	);

	it("Given non-image bytes when display runs then they stay an octet-stream like the Python kernel", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// When
			const run = await runJavaScriptCell(kernel, `display(Buffer.from("binary", "utf8"));`);

			// Then
			expect(displays(run.messages)).toEqual([
				{
					type: "display",
					mimeType: "application/octet-stream",
					dataBase64: Buffer.from("binary").toString("base64"),
				},
			]);
		});
	});

	it("Given a Blob when display runs then the cell waits for the encoded image frame", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// When
			const run = await runJavaScriptCell(
				kernel,
				`display(new Blob([new Uint8Array([${PNG_BYTES.join(",")}])], { type: "image/png" })); print("after");`,
			);

			// Then
			expect(displays(run.messages)).toEqual([{ type: "display", mimeType: "image/png", dataBase64: PNG_BASE64 }]);
			expect(stdout(run.messages)).toContain("after");
		});
	});

	it("Given a data URL when display runs then the payload is decoded", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const code = `display({ type: "image", mimeType: "image/png", data: "data:image/png;base64,${PNG_BASE64}" });`;

			// When
			const run = await runJavaScriptCell(kernel, code);

			// Then
			expect(displays(run.messages)).toEqual([{ type: "display", mimeType: "image/png", dataBase64: PNG_BASE64 }]);
		});
	});

	it("Given wrapped base64 when display runs then whitespace is normalized away", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given base64 as `base64`/`openssl` emit it — wrapped at a column.
			const wrapped = PNG_BASE64.replace(/(.{8})/gu, "$1\n");
			const code = `display({ type: "image", mimeType: "image/png", data: ${JSON.stringify(wrapped)} });`;

			// When
			const run = await runJavaScriptCell(kernel, code);

			// Then
			expect(displays(run.messages)).toEqual([{ type: "display", mimeType: "image/png", dataBase64: PNG_BASE64 }]);
		});
	});

	it("Given a Bun.Image when display runs then the encoded image is emitted", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given a real PNG on disk that Bun can decode.
			const dir = await mkdtemp(join(tmpdir(), "senpi-eval-image-"));
			const file = join(dir, "probe.png");
			const png = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			);
			await writeFile(file, png);

			try {
				// When
				const run = await runJavaScriptCell(
					kernel,
					`if (typeof Bun === "undefined") { display({ type: "image", mimeType: "image/png", data: ${JSON.stringify(png.toString("base64"))} }); } else { display(await Bun.file(${JSON.stringify(file)}).image().png()); }`,
				);

				// Then
				const emitted = displays(run.messages);
				expect(emitted).toHaveLength(1);
				expect(emitted[0]?.mimeType).toBe("image/png");
				expect(Buffer.from(emitted[0]?.dataBase64 ?? "", "base64").subarray(0, 8)).toEqual(
					Buffer.from(PNG_BYTES.slice(0, 8)),
				);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	});
});
