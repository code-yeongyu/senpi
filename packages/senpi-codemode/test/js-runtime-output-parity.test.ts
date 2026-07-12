import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

const pngBytes = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const pngBase64 = Buffer.from(pngBytes).toString("base64");

function textOutput(messages: readonly KernelToHostMessage[], stream: "stdout" | "stderr"): string {
	return messages
		.flatMap((message) => (message.type === "text" && message.stream === stream ? [message.data] : []))
		.join("");
}

function displayOutput(
	messages: readonly KernelToHostMessage[],
): readonly Extract<KernelToHostMessage, { type: "display" }>[] {
	return messages.filter(
		(message): message is Extract<KernelToHostMessage, { type: "display" }> => message.type === "display",
	);
}

describe("JavaScript runtime output parity", () => {
	it("Given object rows when console.table runs then the ASCII table reaches cell stdout", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const code = "console.table([{ name: 'Ada', age: 36 }, { name: 'Linus', age: 54 }]);";

			// When
			const run = await runJavaScriptCell(kernel, code);

			// Then
			const stdout = textOutput(run.messages, "stdout");
			expect(stdout).toContain("┌");
			expect(stdout).toContain("(index)");
			expect(stdout).toContain("Ada");
			expect(stdout).toContain("Linus");
			expect(stdout.endsWith("\n")).toBe(true);
		});
	});

	it("Given a columns filter when console.table runs then hidden columns stay absent", async () => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const code = "console.table([{ name: 'Ada', age: 36, secret: 'hidden' }], ['name']);";

			// When
			const run = await runJavaScriptCell(kernel, code);

			// Then
			const stdout = textOutput(run.messages, "stdout");
			expect(stdout).toContain("name");
			expect(stdout).toContain("Ada");
			expect(stdout).not.toContain("secret");
			expect(stdout).not.toContain("hidden");
			expect(stdout).not.toContain("age");
		});
	});

	it.each([
		["stdout string writes", "process.stdout.write('a'); process.stdout.write('b');", "stdout", "ab"],
		["stderr string writes", "process.stderr.write('oops');", "stderr", "oops"],
		["stdout Buffer writes", "process.stdout.write(Buffer.from('héllo', 'utf8'));", "stdout", "héllo"],
	] as const)("Given %s when the cell runs then exact bytes reach the text stream", async (_name, code, stream, text) => {
		await withJavaScriptKernel(async (kernel) => {
			// Given: a live worker kernel.
			// When
			const run = await runJavaScriptCell(kernel, code);

			// Then
			expect(textOutput(run.messages, stream)).toBe(text);
		});
	});

	it.each([
		["strict base64", JSON.stringify(pngBase64)],
		["Uint8Array", `new Uint8Array([${pngBytes.join(",")}])`],
		["Buffer", `Buffer.from([${pngBytes.join(",")}])`],
		["ArrayBuffer", `new Uint8Array([${pngBytes.join(",")}]).buffer`],
		["decimal CSV", JSON.stringify(pngBytes.join(","))],
		["serialized Buffer", `JSON.parse(JSON.stringify(Buffer.from([${pngBytes.join(",")}])))`],
	] as const)("Given image data as %s when display runs then strict base64 is emitted", async (_name, expression) => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const code = `display({ type: "image", data: ${expression}, mimeType: "image/png" });`;

			// When
			const run = await runJavaScriptCell(kernel, code);

			// Then
			expect(displayOutput(run.messages)).toEqual([
				{ type: "display", mimeType: "image/png", dataBase64: pngBase64 },
			]);
		});
	});

	it.each([
		["unrecognized object", "{ not: 'a buffer' }"],
		["invalid base64", JSON.stringify("abcd=efg")],
	] as const)("Given %s image data when display runs then the image is dropped with a diagnostic", async (_name, expression) => {
		await withJavaScriptKernel(async (kernel) => {
			// Given
			const code = `display({ type: "image", data: ${expression}, mimeType: "image/png" });`;

			// When
			const run = await runJavaScriptCell(kernel, code);

			// Then
			expect(displayOutput(run.messages)).toEqual([]);
			expect(textOutput(run.messages, "stdout")).toMatch(/image dropped/u);
		});
	});
});
