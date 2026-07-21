import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { STABLE_CLIENT_REQUEST_METHODS } from "../../../src/modes/app-server/protocol/methods.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";

const REAL_PROVIDER_ENV_KEYS = [
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANT_LING_API_KEY",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"NVIDIA_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MOONSHOT_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"CLOUDFLARE_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ALIBABA_TOKEN_PLAN_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

for (const key of REAL_PROVIDER_ENV_KEYS) {
	delete process.env[key];
}

const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey("task17-faux", "faux-key");
const modelRegistry = ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider("task17-faux", {
	baseUrl: "http://localhost:0",
	apiKey: "faux-key",
	api: "faux",
	models: [
		{
			id: "model-list",
			name: "Task 17 Faux",
			api: "faux",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1024,
			maxTokens: 256,
			baseUrl: "http://localhost:0",
		},
	],
});

const sent: unknown[] = [];
const core = new ServerCore({ modelRegistry, version: "2026.7.2", codexHome: "/tmp/senpi-task17" });
const connection = core.addConnection({
	id: "task17-unimplemented",
	transportKind: "stdio",
	send: (message) => {
		sent.push(message);
	},
	close: () => undefined,
});

await core.receive(connection.id, {
	kind: "request",
	message: {
		id: 1,
		method: "initialize",
		params: {
			clientInfo: { name: "qa", title: "QA", version: "0.0.1" },
			capabilities: { experimentalApi: true, requestAttestation: false },
		},
	},
});

const implemented = new Set(["initialize", "model/list"]);
const unimplementedStableMethods = STABLE_CLIENT_REQUEST_METHODS.filter((method) => !implemented.has(method));
const startedAt = Date.now();
for (const [index, method] of unimplementedStableMethods.entries()) {
	await core.receive(connection.id, { kind: "request", message: { id: index + 10, method, params: {} } });
}
await core.receive(connection.id, { kind: "request", message: { id: 999, method: "thread/search", params: {} } });
const elapsedMs = Date.now() - startedAt;

const responses = sent.slice(1);
const stableResponses = responses.slice(0, unimplementedStableMethods.length);
for (const [index, method] of unimplementedStableMethods.entries()) {
	const response = stableResponses[index];
	if (!response || typeof response !== "object" || !("error" in response)) {
		throw new Error(`expected ${method} to return -32601: ${JSON.stringify(response)}`);
	}
	const error = response.error;
	if (!hasErrorCode(error, -32601)) {
		throw new Error(`expected ${method} to return -32601: ${JSON.stringify(response)}`);
	}
}
const threadSearchResponse = responses[responses.length - 1];
if (
	!threadSearchResponse ||
	typeof threadSearchResponse !== "object" ||
	!("error" in threadSearchResponse) ||
	!hasErrorCode(threadSearchResponse.error, -32601)
) {
	throw new Error(`expected thread/search to stay unsupported: ${JSON.stringify(threadSearchResponse)}`);
}
if (elapsedMs >= 2000) {
	throw new Error(`unimplemented method sweep exceeded 2s: ${elapsedMs}`);
}

console.log(`UNIMPLEMENTED_STABLE_COUNT=${unimplementedStableMethods.length}`);
console.log(`THREAD_SEARCH_UNSUPPORTED=true`);
console.log(`SWEEP_UNDER_2S=${elapsedMs < 2000}`);

function hasErrorCode(value: unknown, code: number): value is { readonly code: number } {
	return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
