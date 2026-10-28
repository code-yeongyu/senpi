import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamSimpleOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const READ_TOOL = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

interface CapturedRequest {
	readonly url: string;
	readonly body: Record<string, unknown>;
}

async function sendAgainst404(
	model: Model<"openai-codex-responses">,
	reasoning: "off" | "high",
): Promise<{ request: CapturedRequest; result: AssistantMessage }> {
	const urls: string[] = [];
	const bodies: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			urls.push(String(input));
			return new Response(null, { status: 404 });
		}),
	);
	const context = normalizeContext({
		messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
		tools: [READ_TOOL],
	});
	const result = await streamSimpleOpenAICodexResponses(model, context, {
		apiKey: mockToken(),
		transport: "sse",
		maxRetries: 0,
		onPayload: (payload) => {
			bodies.push(payload as Record<string, unknown>);
			return undefined;
		},
		...(reasoning === "off" ? {} : { reasoning }),
	}).result();
	const [url] = urls;
	const [body] = bodies;
	if (url === undefined || body === undefined) throw new Error("no request was sent");
	return { request: { url, body }, result };
}

afterEach(() => vi.unstubAllGlobals());

describe("GPT-6.1 Terra on the ChatGPT subscription (senpi#4578)", () => {
	it("ships in the generated chatgpt-subscription catalog beside GPT-6.1 Sol", () => {
		const terra = getModel("chatgpt-subscription", "gpt-6.1-terra");
		const sol = getModel("chatgpt-subscription", "gpt-6.1-sol");
		expect(terra).toMatchObject({
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: sol.baseUrl,
			contextWindow: 500000,
			maxTokens: sol.maxTokens,
			input: ["text", "image"],
			reasoning: true,
		});
		const api = getModel("openai", "gpt-6.1-terra");
		expect(terra.cost).toMatchObject({
			input: api.cost.input,
			output: api.cost.output,
			cacheRead: api.cost.cacheRead,
		});
		expect(terra.thinkingLevelMap).toMatchObject({ off: "none", minimal: null, max: "max" });
		expect(terra.compat).toEqual({
			supportsOpenAIGrammarTools: true,
			supportsAdditionalTools: true,
			supportsToolSearch: true,
			supportsMidConvoSystemMessages: true,
		});
		const { supportsConfigurationUpdate: _solOnly, ...solToolCompat } = sol.compat ?? {};
		expect(terra.compat).toEqual(solToolCompat);
	});

	it("sends the same request shape as GPT-6.1 Sol to the Codex responses endpoint", async () => {
		const terra = await sendAgainst404(getModel("chatgpt-subscription", "gpt-6.1-terra"), "high");
		const sol = await sendAgainst404(getModel("chatgpt-subscription", "gpt-6.1-sol"), "high");

		expect(terra.request.url).toBe(ENDPOINT);
		expect(sol.request.url).toBe(ENDPOINT);
		expect(terra.request.body.model).toBe("gpt-6.1-terra");
		expect(Object.keys(terra.request.body).sort()).toEqual(Object.keys(sol.request.body).sort());
		expect(terra.request.body.reasoning).toEqual(sol.request.body.reasoning);
		expect(terra.request.body.tools).toEqual(sol.request.body.tools);
		expect(terra.request.body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "read" })]));
	});

	it("sends reasoning effort none when thinking is off, which Terra accepts", async () => {
		const { request } = await sendAgainst404(getModel("chatgpt-subscription", "gpt-6.1-terra"), "off");
		expect(request.body.reasoning).toMatchObject({ effort: "none" });
	});

	it("a Terra request answered with a bodiless 404 carries the status-only diagnostic model_unavailable reads", async () => {
		const { result } = await sendAgainst404(getModel("chatgpt-subscription", "gpt-6.1-terra"), "high");
		expect(result.stopReason).toBe("error");
		expect(result.providerDiagnostic).toEqual({
			category: "unknown",
			httpStatus: 404,
			evidence: "structured_status",
		});
	});
});
