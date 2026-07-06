import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { evidenceDir, repoRoot, tsxEntry } from "./common.mjs";

export const API_PRESETS = {
	"openai-completions": {
		provider: "mock",
		modelId: "mock-model",
		apiKey: "sk-mock-qa-7f3a",
		auth: "bearer",
		path: "/chat/completions",
		baseUrl: (server) => server.url,
	},
	"anthropic-messages": {
		provider: "anthropic",
		modelId: "mock-claude",
		apiKey: "sk-ant-mock-7f3a",
		auth: "x-api-key",
		path: "/messages",
		baseUrl: (server) => server.origin,
	},
	"openai-responses": {
		provider: "openai",
		modelId: "mock-gpt",
		apiKey: "sk-openai-mock-7f3a",
		auth: "bearer",
		path: "/responses",
		baseUrl: (server) => server.url,
	},
};

export const ALL_APIS = Object.keys(API_PRESETS);

const PROVIDER_ENV_KEYS = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY",
	"NVIDIA_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
	"FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY",
	"MOONSHOTAI_API_KEY", "KIMI_API_KEY", "OPENCODE_API_KEY", "CLOUDFLARE_API_KEY", "HF_TOKEN",
];

export function hermeticEnv(boxEnv) {
	const env = { ...boxEnv };
	for (const key of PROVIDER_ENV_KEYS) delete env[key];
	return env;
}

export function writeMockModelsJson(agentDir, server, apiName) {
	const preset = API_PRESETS[apiName];
	const baseUrl = preset.baseUrl(server);
	const config = {
		providers: {
			[preset.provider]: {
				baseUrl,
				apiKey: preset.apiKey,
				api: apiName,
				models: [
					{
						id: preset.modelId,
						baseUrl,
						api: apiName,
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(config, null, 2));
}

export function assertMcpFixtureToolName(toolName) {
	if (!/^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/.test(toolName)) {
		throw new Error(`--with-mcp-tool requires an mcp_<server>_<tool> name, got: ${toolName}`);
	}
	if (!/^mcp_fx_tool_\d+$/.test(toolName)) {
		throw new Error(`mock-loop MCP fixture can register mcp_fx_tool_<n> tools only, got: ${toolName}`);
	}
}

export function mcpFixtureForToolName(toolName) {
	const match = /^mcp_fx_tool_(\d+)$/.exec(toolName);
	const toolIndex = Number(match?.[1] ?? "1");
	return {
		sourceToolName: `tool_${toolIndex}`,
		toolCount: toolIndex,
		resultPrefix: `fixture tool_${toolIndex}`,
	};
}

export function writeMcpFixtureExtension(box, { toolName, fixture }) {
	const root = repoRoot();
	const callLogPath = join(box.dir, "mcp-fixture-calls.jsonl");
	const extensionPath = join(box.dir, "mcp-fixture-extension.mjs");
	const typeboxUrl = pathToFileURL(join(root, "node_modules", "typebox", "build", "index.mjs")).href;
	const clientUrl = pathToFileURL(
		join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js"),
	).href;
	const stdioUrl = pathToFileURL(
		join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "stdio.js"),
	).href;
	const source = `
import { appendFileSync } from "node:fs";
import { Type } from ${JSON.stringify(typeboxUrl)};
import { Client } from ${JSON.stringify(clientUrl)};
import { StdioClientTransport } from ${JSON.stringify(stdioUrl)};

const toolName = ${JSON.stringify(toolName)};
const sourceToolName = ${JSON.stringify(fixture.sourceToolName)};
const callLogPath = ${JSON.stringify(callLogPath)};
const fixtureCommand = ${JSON.stringify(process.execPath)};
const fixtureArgs = ${JSON.stringify([
		tsxEntry(root),
		"--tsconfig",
		join(root, "tsconfig.json"),
		join(root, "packages", "coding-agent", "test", "mcp", "fixtures", "stdio-server.ts"),
		"--tools",
		String(fixture.toolCount),
	])};

export default function(pi) {
	pi.registerTool({
		name: toolName,
		label: "MCP fixture tool",
		description: "senpi-qa local MCP stdio fixture proxy. Returns deterministic fixture text.",
		parameters: Type.Object({
			value: Type.Optional(Type.String()),
			mode: Type.Optional(Type.String()),
			nested: Type.Optional(Type.Any())
		}, { additionalProperties: true }),
		async execute(toolCallId, params) {
			const transport = new StdioClientTransport({ command: fixtureCommand, args: fixtureArgs, stderr: "pipe" });
			const client = new Client({ name: "senpi-qa-mcp-fixture-proxy", version: "0.0.0" });
			try {
				await client.connect(transport, { timeout: 3000 });
				const listed = await client.listTools();
				if (!listed.tools.some((tool) => tool.name === sourceToolName)) {
					throw new Error("MCP fixture did not list " + sourceToolName);
				}
				const result = await client.callTool({ name: sourceToolName, arguments: params });
				appendFileSync(callLogPath, JSON.stringify({ toolCallId, toolName, sourceToolName, params, listed: listed.tools.map((tool) => tool.name), result }) + "\\n");
				return { content: result.content, details: { fixture: "mcp-stdio", sourceToolName, listed: listed.tools.map((tool) => tool.name) } };
			} finally {
				await client.close().catch((error) => {
					appendFileSync(callLogPath, JSON.stringify({ cleanupError: error instanceof Error ? error.name : typeof error }) + "\\n");
				});
			}
		}
	});
}
`;
	writeFileSync(extensionPath, source);
	return {
		extraArgs: ["--extension", extensionPath],
		callLogPath,
		expectedResultText: fixture.resultPrefix,
		extensionPath,
	};
}

export function validateMcpFixtureToolResult({ prepared, server }) {
	const calls = readFixtureCalls(prepared.callLogPath);
	const fixtureCall = calls.find((call) => call.toolName && call.sourceToolName);
	const requestSawResult = server.requests
		.slice(1)
		.some((request) => JSON.stringify(request.messages ?? "").includes(prepared.expectedResultText));
	return {
		name: "requested MCP fixture tool exists, executed, and fed result back to model",
		pass: !!fixtureCall && requestSawResult,
		detail: `callLog=${fixtureCall ? "yes" : "no"} modelSawFixtureResult=${requestSawResult}`,
	};
}

function readFixtureCalls(path) {
	if (!path || !existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				return { parseError: safeErrorReason(error), line: index + 1 };
			}
		});
}

function safeErrorReason(error) {
	return error instanceof Error ? error.name : typeof error;
}

export function writeToolEvidence(slug, { apiName, result, server, prepared }) {
	const dir = evidenceDir(slug);
	writeFileSync(join(dir, `mock-loop-${apiName}-stdout.txt`), result.stdout);
	writeFileSync(join(dir, `mock-loop-${apiName}-stderr.txt`), result.stderr);
	writeFileSync(join(dir, `mock-loop-${apiName}-requests.json`), JSON.stringify(sanitizeRequests(server.requests), null, 2));
	if (prepared.callLogPath && existsSync(prepared.callLogPath)) {
		writeFileSync(join(dir, "mcp-fixture-calls.jsonl"), readFileSync(prepared.callLogPath, "utf8"));
	}
	writeFileSync(
		join(dir, "summary.json"),
		JSON.stringify(
			{
				command: `node .agents/skills/senpi-qa/scripts/mock-loop.mjs ${process.argv.slice(2).join(" ")}`,
				apiName,
				requests: server.requests.length,
				fixtureCallLog: prepared.callLogPath ? "mcp-fixture-calls.jsonl" : null,
			},
			null,
			2,
		),
	);
	process.stderr.write(`evidence: ${dir}\n`);
}

function sanitizeRequests(requests) {
	return requests.map((request) => ({
		...request,
		authorization: request.authorization ? "<mock-redacted>" : null,
		apiKeyHeader: request.apiKeyHeader ? "<mock-redacted>" : null,
	}));
}
