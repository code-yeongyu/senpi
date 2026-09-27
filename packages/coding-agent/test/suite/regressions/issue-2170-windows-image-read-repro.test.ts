// CI-mirror reproduction for senpi#2170 (not for merge): exercise the real read tool on a PNG
// referenced by Windows-style paths, then serialize the tool result exactly as the Codex
// Responses transport does, and dump every produced image payload for an independent decoder.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Context, convertResponsesMessages, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../../../src/core/tools/read.ts";
import { normalizeToolResultImages } from "../../../src/utils/tool-result-images.ts";

const screenshotsDir = process.env.WIN_IMAGE_REPRO_DIR ?? join(homedir(), "Pictures", "Screenshots");
const outDir = process.env.WIN_IMAGE_REPRO_OUT ?? join(process.cwd(), "win-image-repro-out");
const runtime = typeof process.versions.bun === "string" ? `bun-${process.versions.bun}` : `node-${process.versions.node}`;

const codexModel = {
	id: "gpt-5.5",
	name: "gpt-5.5",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
} as unknown as Model<"openai-codex-responses">;

function pathVariants(file: string): Array<[string, string]> {
	const variants: Array<[string, string]> = [["native", file]];
	if (process.platform === "win32") {
		variants.push(
			["backslash", file.replaceAll("/", "\\")],
			["forward-slash", file.replaceAll("\\", "/")],
			["lower-drive", file.replace(/^([A-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`)],
			["double-quoted", `"${file}"`],
			["at-prefixed", `@${file}`],
			["tilde-backslash", file.replace(homedir(), "~")],
			["tilde-forward", file.replace(homedir(), "~").replaceAll("\\", "/")],
		);
	}
	return variants;
}

describe(`senpi#2170 Windows image read repro (${runtime}, ${process.platform})`, () => {
	it("reads every screenshot through the real read tool and serializes a valid Codex image payload", async () => {
		mkdirSync(outDir, { recursive: true });
		const files = readdirSync(screenshotsDir)
			.filter((name) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name))
			.map((name) => join(screenshotsDir, name));
		expect(files.length).toBeGreaterThan(0);
		const read = createReadToolDefinition(process.cwd());
		const rows: string[] = [];
		for (const file of files) {
			for (const [variant, input] of pathVariants(file)) {
				let row: Record<string, unknown> = { runtime, file: file.replace(homedir(), "~"), variant };
				try {
					const result = await read.execute("call-1", { path: input }, undefined, undefined);
					const content = await normalizeToolResultImages(result.content as never);
					const images = content.filter((block): block is ImageContent => block.type === "image");
					const texts = content.filter((block) => block.type === "text").map((block) => block.text);
					const context: Context = {
						messages: [
							{
								role: "toolResult",
								toolCallId: "call_1|fc_1",
								toolName: "read",
								content,
								isError: false,
								timestamp: Date.now(),
							},
						],
					};
					const input_ = convertResponsesMessages(codexModel, context, new Set(["openai-codex"]));
					const serialized = JSON.stringify(input_);
					const urls = [...serialized.matchAll(/"image_url":"([^"]*)"/g)].map((m) => m[1]);
					row = { ...row, texts, imageCount: images.length, urlCount: urls.length };
					urls.forEach((url, index) => {
						const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+=*)$/.exec(url);
						const bytes = match ? Buffer.from(match[2], "base64") : Buffer.alloc(0);
						const roundTrip = match ? bytes.toString("base64") === match[2] : false;
						const name = `${runtime}-${variant}-${index}-${file.split(/[\\/]/).pop()}.${match?.[1].split("/")[1] ?? "bin"}`;
						writeFileSync(join(outDir, name), bytes);
						row[`url${index}`] = {
							mime: match?.[1] ?? null,
							prefixOk: Boolean(match),
							doublePrefix: url.includes("base64,data:"),
							roundTrip,
							bytes: bytes.length,
							head: bytes.subarray(0, 8).toString("hex"),
							sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
							dump: name,
						};
					});
				} catch (error) {
					row.error = error instanceof Error ? error.message : String(error);
				}
				rows.push(JSON.stringify(row));
				console.log(`[win-image-repro] ${JSON.stringify(row)}`);
			}
		}
		writeFileSync(join(outDir, `${runtime}-rows.jsonl`), `${rows.join("\n")}\n`);
	}, 120_000);
});
