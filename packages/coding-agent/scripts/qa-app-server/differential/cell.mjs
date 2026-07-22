import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ORACLE_BINARY } from "./build-oracle.mjs";

export const FAKE_MODEL_PORT = 18990;
export const CODEX_PORT = 18991;
export const SENPI_PORT = 18992;
export const SAFE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const CELL_PREFIX = "/tmp/senpi-app-server-differential-";
const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..", "..", "..");
const repoRoot = resolve(packageDir, "..", "..");

class CellSetupError extends Error {
	name = "CellSetupError";
}

export function createCell({ codexApprovalPolicy = "never", senpiPermissionPreset } = {}) {
	const dir = mkdtempSync(CELL_PREFIX);
	let active = true;
	try {
		const home = join(dir, "home");
		const codexHome = join(dir, "codex-home");
		const senpiAgentDir = join(dir, "senpi-agent");
		const senpiSessionDir = join(dir, "senpi-sessions");
		const workDir = join(dir, "work");
		for (const path of [home, codexHome, senpiAgentDir, senpiSessionDir, workDir]) {
			mkdirSync(path, { recursive: true });
		}

		const token = randomBytes(32).toString("hex");
		const tokenPath = join(dir, "ws-token");
		writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		chmodSync(tokenPath, 0o600);
		writeFileSync(join(codexHome, "config.toml"), codexConfig(codexApprovalPolicy), { encoding: "utf8", mode: 0o600 });
		writeFileSync(join(senpiAgentDir, "models.json"), `${JSON.stringify(senpiModels(), null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		if (senpiPermissionPreset !== undefined) {
			writeFileSync(join(senpiAgentDir, "settings.json"), `${JSON.stringify({ permissionPreset: senpiPermissionPreset })}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
		}

		return Object.freeze({
			dir,
			home,
			codexHome,
			senpiAgentDir,
			senpiSessionDir,
			workDir,
			token,
			tokenPath,
			cleanup() {
				if (!active) return;
				active = false;
				if (!dir.startsWith(CELL_PREFIX)) throw new CellSetupError(`Refusing to remove unexpected cell path: ${dir}`);
				rmSync(dir, { recursive: true, force: true });
			},
		});
	} catch (error) {
		active = false;
		rmSync(dir, { recursive: true, force: true });
		throw new CellSetupError("Failed to create isolated differential QA cell.", { cause: error });
	}
}

export function codexLaunch(cell) {
	return Object.freeze({
		label: "codex",
		command: "/usr/bin/env",
		args: [
			"-i",
			`PATH=${SAFE_PATH}`,
			`HOME=${cell.home}`,
			`CODEX_HOME=${cell.codexHome}`,
			"CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG=1",
			"CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1",
			"QA_DUMMY_OPENAI_KEY=qa-dummy-key",
			ORACLE_BINARY,
			"--listen",
			`ws://127.0.0.1:${CODEX_PORT}`,
			"--ws-auth",
			"capability-token",
			"--ws-token-file",
			cell.tokenPath,
			"--disable-plugin-startup-tasks-for-tests",
		],
		cwd: cell.workDir,
		env: {},
	});
}

export function senpiLaunch(cell) {
	return Object.freeze({
		label: "senpi",
		command: process.execPath,
		args: [
			join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			join(repoRoot, "tsconfig.json"),
			join(packageDir, "src", "cli.ts"),
			"app-server",
			"--listen",
			`ws://127.0.0.1:${SENPI_PORT}`,
			"--ws-auth",
			cell.tokenPath,
		],
		cwd: cell.workDir,
		env: {
			PATH: SAFE_PATH,
			HOME: cell.home,
			SENPI_CODING_AGENT_DIR: cell.senpiAgentDir,
			SENPI_CODING_AGENT_SESSION_DIR: cell.senpiSessionDir,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			PAGER: "cat",
			GIT_PAGER: "cat",
		},
	});
}

function codexConfig(approvalPolicy) {
	return `model = "mock-model"
model_provider = "mock_provider"
approval_policy = "${approvalPolicy}"
sandbox_mode = "read-only"

[features]
shell_snapshot = false

[model_providers.mock_provider]
name = "Mock provider for differential QA"
base_url = "http://127.0.0.1:${FAKE_MODEL_PORT}/v1"
wire_api = "responses"
env_key = "QA_DUMMY_OPENAI_KEY"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`;
}

function senpiModels() {
	return {
		providers: {
			mock_provider: {
				api: "openai-responses",
				apiKey: "qa-dummy-key",
				baseUrl: `http://127.0.0.1:${FAKE_MODEL_PORT}/v1`,
				models: [
					{
						id: "mock-model",
						name: "Mock model",
						api: "openai-responses",
						baseUrl: `http://127.0.0.1:${FAKE_MODEL_PORT}/v1`,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
}
