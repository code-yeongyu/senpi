import { createServer, type IncomingMessage, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { fetchDevinModels } from "../src/api/devin-agent/discovery.ts";
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "../src/api/devin-agent/gen/cascade_pb.ts";
import { getBuiltinApiProvider } from "../src/api-registry.ts";
import { createModels } from "../src/models.ts";
import { devinProvider } from "../src/providers/devin.ts";
import "../src/compat.ts";

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	const closing = server;
	server = undefined;
	await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function serve(
	handler: (req: IncomingMessage, body: Buffer, res: import("node:http").ServerResponse) => void,
): Promise<string> {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => handler(req, Buffer.concat(chunks), res));
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
	const address = server?.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}`;
}

type Configs = Parameters<typeof create<typeof GetCliModelConfigsResponseSchema>>[1];

function rawProto(configs: Configs): Buffer {
	return Buffer.from(toBinary(GetCliModelConfigsResponseSchema, create(GetCliModelConfigsResponseSchema, configs)));
}

const CATALOG: Configs = {
	clientModelConfigs: [
		{
			modelUid: "swe-2-high",
			label: "SWE-2 (high)",
			maxTokens: 262_000,
			supportsImages: true,
			isRecommended: true,
			modelInfo: {
				maxOutputTokens: 64_000,
				modelFeatures: {
					supportsImages: true,
					supportsToolCalls: true,
					supportsThinking: true,
					supportsParallelToolCalls: true,
				},
			},
			modelDimensions: [
				{ label: "Input", value: 0.3, denominator: "1M tokens", kind: 1 },
				{ label: "Cached input", value: 0.03, denominator: "1M tokens", kind: 2 },
				{ label: "Output", value: 1.5, denominator: "1M tokens", kind: 1 },
			],
		},
		{ modelUid: "swe-1-6", label: "SWE-1.6", maxTokens: 200_000, supportsImages: true },
		{ modelUid: "adaptive", label: "Adaptive", maxTokens: 200_000, modelInfo: { displayOption: 3 } },
		{ modelUid: "quick-review", label: "Quick Review", maxTokens: 200_000, modelInfo: { displayOption: 4 } },
		{ modelUid: "internal-default", label: "Internal", maxTokens: 200_000, modelInfo: { displayOption: 6 } },
		{ modelUid: "disabled-one", label: "Disabled", disabled: true },
		{ label: "No uid" },
	],
};

describe.sequential("devin provider", () => {
	it("registers the devin-agent api in the builtin registry", () => {
		expect(getBuiltinApiProvider("devin-agent")).toBeDefined();
	});

	it("ships a plan-available SWE seed and binds Devin OAuth", () => {
		const provider = devinProvider();
		expect(provider.id).toBe("devin");
		expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Devin");
		const seeded = provider.getModels();
		const ids = seeded.map((model) => model.id);
		expect(ids[0]).toBe("swe-2-high");
		expect(ids).toEqual(
			expect.arrayContaining(["swe-2-low", "swe-2-max", "swe-2-high-lite", "swe-1-6", "swe-1-6-fast"]),
		);
		expect(ids).not.toContain("swe-2");
		for (const model of seeded) {
			expect(model.api).toBe("devin-agent");
			expect(model.provider).toBe("devin");
			expect(model.baseUrl).toBe("https://server.codeium.com");
		}
	});

	it("resolves a stored Devin OAuth credential as the session token", async () => {
		const models = createModels({ credentials: undefined });
		models.setProvider(devinProvider());
		expect(models.getProvider("devin")?.auth.oauth).toBeDefined();
	});

	it("asks GetCliModelConfigs as a raw proto unary with the dev-channel identity", async () => {
		let seen: { headers: IncomingMessage["headers"]; body: Buffer } | undefined;
		const baseUrl = await serve((req, body, res) => {
			expect(req.url).toBe("/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
			seen = { headers: req.headers, body };
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(rawProto(CATALOG));
		});

		const models = await fetchDevinModels({ apiKey: "abc", baseUrl });
		expect(models?.length).toBeGreaterThan(0);
		if (!seen) throw new Error("no request");
		expect(seen.headers["content-type"]).toBe("application/proto");
		expect(seen.headers["connect-protocol-version"]).toBe("1");
		expect(seen.headers.authorization).toBeUndefined();
		const request = fromBinary(GetCliModelConfigsRequestSchema, seen.body);
		expect(request.metadata).toMatchObject({
			apiKey: "devin-session-token$abc",
			ideName: "chisel",
			ideVersion: "0.0.0-dev",
			extensionName: "chisel",
			extensionVersion: "0.0.0-dev",
			supportedModelDisplays: [3, 4, 6, 7, 8],
		});
	});

	it("normalizes the CLI model configs into catalog models the way the native client does", async () => {
		const baseUrl = await serve((_req, _body, res) => {
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(rawProto(CATALOG));
		});

		const models = await fetchDevinModels({ apiKey: "abc", baseUrl });
		expect(models?.map((model) => model.id)).toEqual(["adaptive", "swe-1-6", "swe-2-high"]);
		const high = models?.find((model) => model.id === "swe-2-high");
		expect(high).toMatchObject({
			name: "SWE-2 (high)",
			api: "devin-agent",
			provider: "devin",
			baseUrl,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262_000,
			maxTokens: 64_000,
			cost: { input: 0.3, output: 1.5, cacheRead: 0.03, cacheWrite: 0 },
			compat: { supportsParallelToolCalls: true },
		});
		expect(models?.find((model) => model.id === "swe-1-6")).toMatchObject({
			input: ["text"],
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		expect(models?.find((model) => model.id === "adaptive")).toMatchObject({ compat: { modelRouter: true } });
	});

	it("decodes a gzipped unary body as well as a bare one", async () => {
		const baseUrl = await serve((_req, _body, res) => {
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(
				gzipSync(rawProto({ clientModelConfigs: [{ modelUid: "swe-2-high", label: "SWE-2", maxTokens: 1 }] })),
			);
		});
		const models = await fetchDevinModels({ apiKey: "abc", baseUrl });
		expect(models?.map((model) => model.id)).toEqual(["swe-2-high"]);
	});

	it("keeps the static seed when discovery fails or returns nothing", async () => {
		const errorUrl = await serve((_req, _body, res) => {
			res.writeHead(500);
			res.end("nope");
		});
		expect(await fetchDevinModels({ apiKey: "abc", baseUrl: errorUrl })).toBeUndefined();

		const closing = server;
		server = undefined;
		await new Promise<void>((resolve) => closing?.close(() => resolve()));

		const emptyUrl = await serve((_req, _body, res) => {
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(
				rawProto({ clientModelConfigs: [{ modelUid: "internal", label: "x", modelInfo: { displayOption: 4 } }] }),
			);
		});
		expect(await fetchDevinModels({ apiKey: "abc", baseUrl: emptyUrl })).toBeUndefined();
	});
});
