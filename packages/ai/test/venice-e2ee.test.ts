import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "../src/providers/faux.ts";
import type { AssistantMessage, Context } from "../src/types.ts";

/**
 * Wire contract for Venice E2EE: an `e2ee-*` turn leaves as ciphertext, the
 * Intel TDX quote must bind the key that can decrypt it, and the SSE body is
 * plaintext by the time the OpenAI parser reads it. node:crypto is the oracle.
 * A wrong keccak, ECDH, HKDF salt, or quote offset fails this file.
 */

const MODEL_PRIVATE = Buffer.concat([Buffer.alloc(31), Buffer.from([0x01])]);
const modelKey = createECDH("secp256k1");
modelKey.setPrivateKey(MODEL_PRIVATE);
const MODEL_PUBLIC = modelKey.getPublicKey();
const MODEL_PUBLIC_HEX = MODEL_PUBLIC.toString("hex");
const MODEL_ADDRESS = Buffer.from("7e5f4552091a69125d5dfcb7b8c2659029395bdf", "hex");
const GENERATOR_PUBLIC =
	"0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

const SYSTEM = "SYSTEM_SENTINEL_do_not_leak";
const ASSISTANT = "ASSISTANT_SENTINEL_do_not_leak";
const ARGS = "ARGS_SENTINEL_do_not_leak";
const TOOL_RESULT = "TOOL_RESULT_SENTINEL_do_not_leak";
const USER = "USER_SENTINEL_do_not_leak";
const SCHEMA = "TOOL_SCHEMA_SENTINEL_do_not_leak";
const REPLY = "enclave says hello";

const E2EE_ROWS = [
	["e2ee-glm-5-3-p", 1_000_000, 131_072, 1.75, 5.5],
	["e2ee-glm-5-3-flash", 1_000_000, 131_072, 0.16, 0.54],
	["e2ee-glm-5-2-p", 524_288, 131_072, 1.75, 5.75],
	["e2ee-deepseek-v4-flash", 1_000_000, 32_768, 0.18, 0.37],
	["e2ee-gpt-oss-120b-p", 128_000, 16_384, 0.13, 0.65],
] as const;

type QuoteMode = "valid" | "debug" | "wrong-address" | "wrong-nonce" | "missing-quote" | "unverified";

interface Captured {
	url: string;
	method: string;
	headers: Headers;
	body: string;
}

function sharedX(privateKey: Buffer, peerPublic: Buffer): Buffer {
	const ecdh = createECDH("secp256k1");
	ecdh.setPrivateKey(privateKey);
	const shared = ecdh.computeSecret(peerPublic);
	return Buffer.concat([Buffer.alloc(32), shared]).subarray(-32);
}

function aesKey(shared: Buffer): Buffer {
	return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(32), Buffer.from("ecdsa_encryption"), 32));
}

function nodeEncrypt(plaintext: string, peerPublic: Buffer): string {
	const ephemeral = createECDH("secp256k1");
	ephemeral.generateKeys();
	const key = aesKey(sharedX(ephemeral.getPrivateKey(), peerPublic));
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([ephemeral.getPublicKey(), nonce, data, cipher.getAuthTag()]).toString("hex");
}

function nodeDecrypt(ciphertextHex: string, privateKey: Buffer): string {
	const raw = Buffer.from(ciphertextHex, "hex");
	const key = aesKey(sharedX(privateKey, raw.subarray(0, 65)));
	const nonce = raw.subarray(65, 77);
	const sealed = raw.subarray(77);
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString("utf8");
}

/** Intel TDX quote v4: header 48 bytes, TD attributes at body 0x78, REPORTDATA at body 0x208. */
function quoteV4(address: Buffer, nonce: Buffer, debug: boolean): Buffer {
	const body = Buffer.alloc(0x248);
	body[0x78] = debug ? 0x01 : 0x00;
	address.copy(body, 0x208);
	nonce.copy(body, 0x208 + 32);
	const quote = Buffer.alloc(0x30 + body.length);
	quote.writeUInt16LE(4, 0);
	quote.writeUInt32LE(0x81, 4);
	body.copy(quote, 0x30);
	return quote;
}

function attestationResponse(url: string, mode: QuoteMode): Response {
	const parsed = new URL(url);
	const nonceHex = parsed.searchParams.get("nonce") ?? "";
	const nonce = Buffer.from(nonceHex, "hex");
	const address = mode === "wrong-address" ? Buffer.alloc(20, 0xff) : MODEL_ADDRESS;
	const reportNonce = mode === "wrong-nonce" ? Buffer.alloc(32, 0x11) : nonce;
	const body: Record<string, unknown> = {
		verified: mode !== "unverified",
		nonce: nonceHex,
		model: parsed.searchParams.get("model"),
		signing_key: MODEL_PUBLIC_HEX,
		signing_address: `0x${MODEL_ADDRESS.toString("hex")}`,
	};
	if (mode !== "missing-quote") {
		body.intel_quote = quoteV4(address, reportNonce, mode === "debug").toString("base64");
	}
	return Response.json(body);
}

function sseResponse(content: string): Response {
	const chunk = {
		id: "chatcmpl-e2ee",
		object: "chat.completion.chunk",
		created: 0,
		model: "e2ee-glm-5-3-p",
		choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
	};
	const done = {
		...chunk,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 3, completion_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function readBody(body: BodyInit | null | undefined): Promise<string> {
	if (body == null) return "";
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return new Response(body).text();
}

function createFetch(mode: QuoteMode, reply: string, corrupt = false) {
	const calls: Captured[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const headers = new Headers(init?.headers);
		const method = (
			init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")
		).toUpperCase();
		const body = await readBody(init?.body);
		calls.push({ url, method, headers, body });
		if (url.includes("/tee/attestation")) return attestationResponse(url, mode);
		if (!url.includes("/chat/completions")) throw new Error(`unexpected Venice URL ${url}`);
		if (corrupt) return sseResponse("ab".repeat(100));
		const clientPublic = headers.get("x-venice-tee-client-pub-key");
		if (!clientPublic) throw new Error("E2EE chat request is missing the client public key");
		return sseResponse(nodeEncrypt(reply, Buffer.from(clientPublic, "hex")));
	};
	return { fetchImpl, calls };
}

function assistantText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

const history: Context = {
	systemPrompt: SYSTEM,
	tools: [{ name: "read_secret", description: SCHEMA, parameters: Type.Object({}) }],
	messages: [
		{ role: "user", content: "first", timestamp: 0 },
		fauxAssistantMessage([fauxText(ASSISTANT), fauxToolCall("read_secret", { path: ARGS }, { id: "call_1" })], {
			stopReason: "toolUse",
			timestamp: 1,
		}),
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read_secret",
			content: [{ type: "text", text: TOOL_RESULT }],
			isError: false,
			timestamp: 2,
		},
		{ role: "user", content: USER, timestamp: 3 },
	],
};

describe("Venice E2EE", () => {
	it("registers published e2ee rows as text-only Venice models", () => {
		expect(MODEL_PUBLIC_HEX).toBe(GENERATOR_PUBLIC);
		for (const [id, contextWindow, maxTokens, input, output] of E2EE_ROWS) {
			expect(getModel("venice", id)).toMatchObject({
				provider: "venice",
				api: "openai-completions",
				baseUrl: "https://api.venice.ai/api/v1",
				reasoning: true,
				input: ["text"],
				contextWindow,
				maxTokens,
				cost: { input, output, cacheRead: 0, cacheWrite: 0 },
				compat: { veniceParameters: { include_venice_system_prompt: false } },
			});
		}
	});

	it("encrypts prompts to the quote-bound key and decrypts the SSE reply", async () => {
		const { fetchImpl, calls } = createFetch("valid", REPLY);
		const result = await streamSimple(getModel("venice", "e2ee-glm-5-3-p"), history, {
			apiKey: "test-venice-key",
			fetch: fetchImpl,
		}).result();

		const attestation = calls.find((call) => call.url.includes("/tee/attestation"));
		const chat = calls.find((call) => call.url.includes("/chat/completions"));
		expect(attestation).toBeDefined();
		expect(chat).toBeDefined();
		expect(attestation?.headers.get("authorization")).toBe("Bearer test-venice-key");
		expect(new URL(attestation?.url ?? "").searchParams.get("nonce")).toMatch(/^[0-9a-f]{64}$/);
		expect(new URL(attestation?.url ?? "").searchParams.get("model")).toBe("e2ee-glm-5-3-p");

		expect(chat?.headers.get("x-venice-tee-model-pub-key")).toBe(MODEL_PUBLIC_HEX);
		expect(chat?.headers.get("x-venice-tee-signing-algo")).toBe("ecdsa");
		expect(chat?.headers.get("x-venice-tee-client-pub-key")).toMatch(/^04[0-9a-f]{128}$/);

		const raw = chat?.body ?? "";
		for (const sentinel of [SYSTEM, ASSISTANT, ARGS, TOOL_RESULT, USER, SCHEMA]) {
			expect(raw).not.toContain(sentinel);
		}
		const payload = JSON.parse(raw) as {
			messages: Array<{ role: string; content: string }>;
			tools?: unknown;
			tool_choice?: unknown;
			stream?: boolean;
			venice_parameters?: Record<string, unknown>;
		};
		expect(payload.tools).toBeUndefined();
		expect(payload.tool_choice).toBeUndefined();
		expect(payload.stream).toBe(true);
		expect(payload.venice_parameters).toEqual({
			include_venice_system_prompt: false,
			enable_web_search: "off",
			enable_web_scraping: false,
			enable_web_citations: false,
			enable_x_search: false,
		});
		expect(JSON.stringify(payload)).not.toContain("enable_e2ee");
		expect(payload.messages.length).toBeGreaterThan(0);
		expect(payload.messages.every((message) => message.role === "system" || message.role === "user")).toBe(true);
		const decrypted = payload.messages.map((message) => nodeDecrypt(message.content, MODEL_PRIVATE)).join("\n");
		for (const sentinel of [SYSTEM, ASSISTANT, ARGS, TOOL_RESULT, USER]) {
			expect(decrypted).toContain(sentinel);
		}
		expect(decrypted).not.toContain(SCHEMA);

		expect(result.stopReason).toBe("stop");
		expect(assistantText(result)).toBe(REPLY);
	});

	it("refuses a quote that does not bind this client, key, or a production TD", async () => {
		const cases = [
			["debug", "debug enclave"],
			["wrong-address", "does not bind the signing key"],
			["wrong-nonce", "does not bind this attestation nonce"],
			["missing-quote", "did not include an Intel TDX quote"],
			["unverified", "was not verified"],
		] as const;
		for (const [mode, message] of cases) {
			const { fetchImpl, calls } = createFetch(mode, REPLY);
			const result = await streamSimple(
				getModel("venice", "e2ee-glm-5-3-p"),
				{ messages: [{ role: "user", content: USER, timestamp: 0 }] },
				{ apiKey: "test-venice-key", fetch: fetchImpl },
			).result();
			expect(result.stopReason, mode).toBe("error");
			expect(result.errorMessage, mode).toContain(message);
			expect(
				calls.some((call) => call.url.includes("/chat/completions")),
				mode,
			).toBe(false);
			expect(calls.map((call) => call.body).join(""), mode).not.toContain(USER);
		}
	});

	it("does not send an image and does not treat undecryptable ciphertext as text", async () => {
		const image: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: USER },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
					timestamp: 0,
				},
			],
		};
		const rejected = createFetch("valid", REPLY);
		const imageResult = await streamSimple(getModel("venice", "e2ee-glm-5-3-p"), image, {
			apiKey: "test-venice-key",
			fetch: rejected.fetchImpl,
		}).result();
		expect(imageResult.stopReason).toBe("error");
		expect(imageResult.errorMessage).toContain("image or audio");
		expect(rejected.calls.some((call) => call.url.includes("/chat/completions"))).toBe(false);

		const corrupt = createFetch("valid", REPLY, true);
		const corruptResult = await streamSimple(
			getModel("venice", "e2ee-glm-5-3-p"),
			{ messages: [{ role: "user", content: "ping", timestamp: 0 }] },
			{ apiKey: "test-venice-key", fetch: corrupt.fetchImpl },
		).result();
		expect(corruptResult.stopReason).toBe("error");
		expect(corruptResult.errorMessage).toMatch(/could not be decrypted|invalid ephemeral public key/);
		expect(assistantText(corruptResult)).not.toContain("abab");
	});

	it("leaves a non-e2ee Venice prompt in plaintext and skips attestation", async () => {
		const calls: Captured[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({
				url,
				method: (init?.method ?? "GET").toUpperCase(),
				headers: new Headers(init?.headers),
				body: await readBody(init?.body),
			});
			return sseResponse("plain-ok");
		};
		const result = await streamSimple(
			getModel("venice", "zai-org-glm-5-2"),
			{ messages: [{ role: "user", content: "hello-plain", timestamp: 0 }] },
			{ apiKey: "test-venice-key", fetch: fetchImpl },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(assistantText(result)).toBe("plain-ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/chat/completions");
		expect(calls[0]?.url).not.toContain("/tee/attestation");
		expect(calls[0]?.body).toContain("hello-plain");
		expect(calls[0]?.headers.get("x-venice-tee-client-pub-key")).toBeNull();
	});
});
