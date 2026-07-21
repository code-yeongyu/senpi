import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
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
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1024,
			maxTokens: 256,
			baseUrl: "http://localhost:0",
		},
		{
			id: "model-list-second",
			name: "Task 17 Faux Second",
			api: "faux",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1024,
			maxTokens: 256,
			baseUrl: "http://localhost:0",
		},
		{
			id: "model-list-third",
			name: "Task 17 Faux Third",
			api: "faux",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1024,
			maxTokens: 256,
			baseUrl: "http://localhost:0",
		},
	],
});

const available = modelRegistry.getAvailable();
const first = available[0];
if (!first) throw new Error("task17 model fixture did not register");
const hidden = { ...first, id: "model-list-hidden", name: "Task 17 Hidden", hidden: true };
const core = new ServerCore({
	modelRegistry: { getAvailable: () => [first, hidden, ...available.slice(1)] },
	version: "2026.7.2",
	codexHome: "/tmp/senpi-task17",
});
const sent: unknown[] = [];
const connection = core.addConnection({
	id: "task17-model-list",
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
await core.receive(connection.id, {
	kind: "request",
	message: { id: 2, method: "model/list", params: { cursor: null, limit: 1, includeHidden: false } },
});

const firstResult = modelListResult(sent[1]);
const firstModel = firstResult.data.find(
	(entry) => typeof entry === "object" && entry !== null && entry.id === "task17-faux/model-list",
);
if (firstModel?.defaultReasoningEffort !== "medium") {
	throw new Error(`model/list returned invalid model payload: ${JSON.stringify(firstModel)}`);
}

await core.receive(connection.id, {
	kind: "request",
	message: { id: 3, method: "model/list", params: { cursor: firstResult.nextCursor, limit: 1 } },
});
await core.receive(connection.id, {
	kind: "request",
	message: { id: 4, method: "model/list", params: { limit: 100, includeHidden: true } },
});

const secondResult = modelListResult(sent[2]);
const allResult = modelListResult(sent[3]);
const paged =
	firstResult.data.length === 1 &&
	firstResult.nextCursor === "1" &&
	secondResult.data.length === 1 &&
	secondResult.data[0]?.model === "model-list-second"
		? 1
		: 0;
const includeHiddenHonored = allResult.data.some(
	(entry) => entry.hidden === true && entry.model === "model-list-hidden",
)
	? 1
	: 0;
console.log(`MODEL_LIST_COUNT=${firstResult.data.length}`);
console.log(`MODEL_LIST_FIRST=${firstModel?.id ?? "missing"}`);
console.log(`PAGED=${paged}`);
console.log(`INCLUDE_HIDDEN_HONORED=${includeHiddenHonored}`);
console.log("EXIT=0");
if (paged !== 1 || includeHiddenHonored !== 1) {
	throw new Error("task17 model/list assertions failed");
}

function modelListResult(value: unknown): {
	readonly data: readonly Record<string, unknown>[];
	readonly nextCursor: string | null;
} {
	if (!value || typeof value !== "object" || !("result" in value)) {
		throw new Error(`model/list did not return success: ${JSON.stringify(value)}`);
	}
	const result = value.result;
	if (!result || typeof result !== "object" || !("data" in result) || !Array.isArray(result.data)) {
		throw new Error(`model/list result shape is invalid: ${JSON.stringify(result)}`);
	}
	const data = result.data.filter(isRecord);
	if (data.length !== result.data.length || !("nextCursor" in result)) {
		throw new Error(`model/list result entries are invalid: ${JSON.stringify(result)}`);
	}
	const nextCursor = result.nextCursor;
	if (nextCursor !== null && typeof nextCursor !== "string") {
		throw new Error(`model/list cursor is invalid: ${JSON.stringify(result)}`);
	}
	return { data, nextCursor };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
