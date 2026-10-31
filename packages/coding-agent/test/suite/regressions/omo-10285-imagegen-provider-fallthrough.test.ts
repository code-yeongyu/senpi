import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageGenAuthModel, ImageGenAuthRegistry } from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import { setImageGenRegistry, setNativeBypass } from "../../../src/core/extensions/builtin/imagegen/state.ts";
import {
	generateImageTool,
	type GenerateImageDetails as ImageDetails,
} from "../../../src/core/extensions/builtin/imagegen/tool.ts";
import { createHarness, type Harness } from "../harness.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const TOOL_NAME = "generate_image";

interface ImageServer {
	server: Server;
	baseUrl: string;
	hits: string[];
}

/** `/no-images/v1` answers like a chat-only gateway (404); `/with-pngs/v1` returns one PNG (an images base URL may not itself contain `/images`). */
async function startImageServer(): Promise<ImageServer> {
	const hits: string[] = [];
	const server = createServer((request, response) => {
		hits.push(`${request.method} ${request.url}`);
		request.resume();
		request.on("end", () => {
			if (request.url?.startsWith("/with-pngs/v1/images/generations")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ created: 0, data: [{ b64_json: PNG_BASE64 }] }));
				return;
			}
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "Not Found", type: "invalid_request_error" } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${port}`, hits };
}

function gatewayRegistry(gateways: Record<string, string>): ImageGenAuthRegistry<ImageGenAuthModel> {
	const models = Object.entries(gateways).map(([provider, baseUrl]) => ({
		provider,
		id: `${provider}-chat`,
		api: "openai-completions",
		baseUrl,
	}));
	return {
		authStorage: { get: () => undefined },
		getAll: () => models,
		getApiKeyAndHeaders: async (model) => ({ ok: true, apiKey: `${model.provider}-key` }),
		getProviderAuth: async () => undefined,
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

describe("omo#10285: generate_image never silently strands on a gateway without an images endpoint", () => {
	let images: ImageServer;
	let harness: Harness;

	beforeEach(async () => {
		images = await startImageServer();
		harness = await createHarness({ extensionFactories: [(pi) => pi.registerTool(generateImageTool)] });
		await harness.session.bindExtensions({});
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), TOOL_NAME]);
		setNativeBypass(false);
	});

	afterEach(async () => {
		setImageGenRegistry(undefined);
		harness.cleanup();
		await new Promise<void>((resolve) => images.server.close(() => resolve()));
	});

	it("skips a scanned gateway that answers 404 and names it in the result", async () => {
		setImageGenRegistry(
			gatewayRegistry({
				"aaa-compat": `${images.baseUrl}/no-images/v1`,
				"bbb-compat": `${images.baseUrl}/with-pngs/v1`,
			}),
		);

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			output_path: "fox.png",
		});

		expect(images.hits).toEqual(["POST /no-images/v1/images/generations", "POST /with-pngs/v1/images/generations"]);
		expect(existsSync(join(harness.tempDir, "fox.png"))).toBe(true);
		expect(result.details.source).toBe("provider-config:bbb-compat");
		expect(resultText(result)).toContain("skipped aaa-compat");
	});

	it("names every provider it tried, and how to pin one, when none serves images", async () => {
		setImageGenRegistry(
			gatewayRegistry({
				"aaa-compat": `${images.baseUrl}/no-images/v1`,
				"bbb-compat": `${images.baseUrl}/also-none/v1`,
			}),
		);

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, { prompt: "a red fox" });

		expect(result.details.reason).toBe("provider_error");
		expect(resultText(result)).toContain(`aaa-compat (${images.baseUrl}/no-images/v1, HTTP 404)`);
		expect(resultText(result)).toContain(`bbb-compat (${images.baseUrl}/also-none/v1, HTTP 404)`);
		expect(resultText(result)).toContain("PI_IMAGE_GEN_PROVIDER");
	});

	it("does not move past a pinned provider: its 404 is the answer", async () => {
		const previous = process.env.PI_IMAGE_GEN_PROVIDER;
		process.env.PI_IMAGE_GEN_PROVIDER = "aaa-compat";
		try {
			setImageGenRegistry(
				gatewayRegistry({
					"aaa-compat": `${images.baseUrl}/no-images/v1`,
					"bbb-compat": `${images.baseUrl}/with-pngs/v1`,
				}),
			);

			const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, { prompt: "a red fox" });

			expect(images.hits).toEqual(["POST /no-images/v1/images/generations"]);
			expect(result.details.reason).toBe("provider_error");
			expect(result.details.source).toBe("provider-config:aaa-compat");
		} finally {
			if (previous === undefined) delete process.env.PI_IMAGE_GEN_PROVIDER;
			else process.env.PI_IMAGE_GEN_PROVIDER = previous;
		}
	});
});
