import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldDetachChildren, trackChild, trackCloser, untrackCloser } from "./cleanup.mjs";

export { cleanupAll, cleanupAllAndWait, installCleanupHooks } from "./cleanup.mjs";
export { startFakeModelServer } from "./fake-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(here, "..", "..", "..");
export const repoRoot = resolve(packageDir, "..", "..");
export const qaPortRange = Object.freeze([18990, 18991, 18992, 18993, 18994, 18995, 18996, 18997, 18998, 18999]);

const providerEnvKeys = Object.freeze([
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
]);

export function makeScratch(label) {
	const dir = mkdtempSync(join(tmpdir(), `senpi-${label}-`));
	const agentDir = join(dir, "agent");
	const sessionDir = join(dir, "sessions");
	const cwd = join(dir, "work");
	for (const path of [agentDir, sessionDir, cwd]) mkdirSync(path, { recursive: true });
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	trackCloser(cleanup);
	const env = hermeticEnv({
		...process.env,
		SENPI_CODING_AGENT_DIR: agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		PAGER: "cat",
		GIT_PAGER: "cat",
	});
	return {
		dir,
		agentDir,
		sessionDir,
		cwd,
		env,
		cleanup: () => {
			untrackCloser(cleanup);
			cleanup();
		},
	};
}

export function hermeticEnv(base) {
	const env = { ...base };
	for (const key of providerEnvKeys) delete env[key];
	return env;
}

export function spawnCli(args, scratch) {
	const sourceRepoRoot = resolve(process.env.SENPI_QA_REPO_ROOT ?? repoRoot);
	const sourcePackageDir = join(sourceRepoRoot, "packages", "coding-agent");
	const child = spawn(
		process.execPath,
		[
			join(sourceRepoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			join(sourceRepoRoot, "tsconfig.json"),
			join(sourcePackageDir, "src", "cli.ts"),
			...args,
		],
		{ cwd: scratch.cwd, detached: shouldDetachChildren(), env: scratch.env, stdio: ["pipe", "pipe", "pipe"] },
	);
	trackChild(child);
	return child;
}

export function writeMockModelsJson(agentDir, fake) {
	const baseUrl = fake.url;
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					mock: {
						baseUrl,
						apiKey: "sk-senpi-app-server-qa",
						api: "openai-completions",
						models: [
							{
								id: "mock-model",
								baseUrl,
								api: "openai-completions",
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
		),
	);
}

export async function findQaPort(preferred) {
	const ports = preferred ? [preferred] : qaPortRange;
	for (const port of ports) {
		if (await canBind(port)) return port;
	}
	throw new Error(`No free QA port in ${ports.join(", ")}`);
}

export function readGeneratedToken(agentDir) {
	return readFileSync(join(agentDir, "app-server", "ws-token"), "utf8").trim();
}

export function makeThreadStartParams(cwd, approvalPolicy = "never") {
	return {
		cwd,
		model: "mock/mock-model",
		modelProvider: "mock",
		approvalPolicy,
	};
}

export function makeTextInput(text) {
	return [{ type: "text", text }];
}

export function uniqueLabel(prefix) {
	return `${prefix}-${randomUUID()}`;
}

function canBind(port) {
	return new Promise((resolveCheck) => {
		const server = createNetServer();
		server.once("error", () => resolveCheck(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolveCheck(true));
		});
	});
}
