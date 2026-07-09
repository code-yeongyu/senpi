import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { MOCK_API_KEY, MOCK_MODEL, MOCK_PROVIDER, startFakeModelServer } from "./rpc-fake-model.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export { MOCK_API_KEY, MOCK_MODEL, MOCK_PROVIDER } from "./rpc-fake-model.ts";

export const PROVIDER_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"NVIDIA_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MOONSHOT_API_KEY",
	"MOONSHOTAI_API_KEY",
	"KIMI_API_KEY",
	"OPENCODE_API_KEY",
	"CLOUDFLARE_API_KEY",
	"HF_TOKEN",
] as const;

export interface RpcHermeticSession {
	readonly client: RpcClient;
	readonly sessionDir: string;
	close(): Promise<void>;
}

interface TextContentBlock {
	readonly type: "text";
	readonly text: string;
}

export interface RpcSessionEntry {
	readonly id: string | undefined;
	readonly type: string;
	readonly message: RpcSessionMessage | undefined;
	readonly summary: string | undefined;
	readonly name: string | undefined;
}

export interface RpcSessionMessage {
	readonly role: string | undefined;
	readonly output: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

export function hermeticProviderEnv(): Record<string, string> {
	return Object.fromEntries(PROVIDER_ENV_KEYS.map((key) => [key, ""]));
}

export function writeRpcModelsJson(agentDir: string, baseUrl: string): void {
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[MOCK_PROVIDER]: {
						baseUrl,
						apiKey: MOCK_API_KEY,
						api: "anthropic-messages",
						models: [
							{
								id: MOCK_MODEL,
								baseUrl,
								api: "anthropic-messages",
								reasoning: true,
								contextWindow: 128000,
								maxTokens: 4096,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
}

export async function startHermeticRpcSession(): Promise<RpcHermeticSession> {
	const sessionDir = join(tmpdir(), `pi-rpc-test-${Date.now()}`);
	mkdirSync(sessionDir, { recursive: true });
	const fakeModelServer = await startFakeModelServer();
	writeRpcModelsJson(sessionDir, fakeModelServer.origin);
	writeFileSync(
		join(sessionDir, "settings.json"),
		`${JSON.stringify({ compaction: { keepRecentTokens: 1 } }, null, 2)}\n`,
	);
	const client = new RpcClient({
		cliPath: join(__dirname, "..", "..", "src", "cli.ts"),
		cwd: join(__dirname, "..", ".."),
		env: {
			...hermeticProviderEnv(),
			ANTHROPIC_API_KEY: MOCK_API_KEY,
			PI_OFFLINE: "1",
			SENPI_CODING_AGENT_DIR: sessionDir,
		},
		provider: MOCK_PROVIDER,
		model: MOCK_MODEL,
	});

	return {
		client,
		sessionDir,
		close: async () => {
			await client.stop();
			await fakeModelServer.close();
			if (existsSync(sessionDir)) {
				rmSync(sessionDir, { recursive: true });
			}
		},
	};
}

export function readSessionEntries(sessionDir: string): readonly RpcSessionEntry[] {
	const sessionsPath = join(sessionDir, "sessions");
	const sessionDirName = readdirSync(sessionsPath)[0];
	if (sessionDirName === undefined) {
		throw new Error("Expected at least one RPC session directory");
	}
	const cwdSessionDir = join(sessionsPath, sessionDirName);
	const sessionFileName = readdirSync(cwdSessionDir).find((fileName) => fileName.endsWith(".jsonl"));
	if (sessionFileName === undefined) {
		throw new Error("Expected exactly one RPC session JSONL file");
	}
	return readFileSync(join(cwdSessionDir, sessionFileName), "utf8").trim().split("\n").map(parseSessionEntry);
}

export function getAssistantText(events: readonly AgentSessionEvent[]): string | undefined {
	for (const event of events) {
		if (event.type !== "message_end" || event.message.role !== "assistant") continue;
		const textContent = event.message.content.find(isTextContentBlock);
		if (textContent) return textContent.text;
	}
	return undefined;
}

export async function waitForSessionWrites(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 200));
}

function parseSessionEntry(line: string): RpcSessionEntry {
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new Error("Expected RPC session JSONL entry with a string type");
	}
	return {
		id: typeof value.id === "string" ? value.id : undefined,
		type: value.type,
		message: parseSessionMessage(value.message),
		summary: typeof value.summary === "string" ? value.summary : undefined,
		name: typeof value.name === "string" ? value.name : undefined,
	};
}

function parseSessionMessage(value: unknown): RpcSessionMessage | undefined {
	if (!isRecord(value)) return undefined;
	return {
		role: typeof value.role === "string" ? value.role : undefined,
		output: typeof value.output === "string" ? value.output : undefined,
	};
}
