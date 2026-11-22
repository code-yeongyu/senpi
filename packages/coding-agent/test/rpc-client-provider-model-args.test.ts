import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { hermeticProviderEnv, MOCK_API_KEY, MOCK_MODEL, MOCK_PROVIDER } from "./helpers/rpc-hermetic.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL = "mock-claude-default";

const tempDirs: string[] = [];

function writeArgvRecorder(): { cliPath: string; argvFile: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-argv-"));
	tempDirs.push(dir);
	const argvFile = join(dir, "argv.json");
	const cliPath = join(dir, "child.mjs");
	writeFileSync(
		cliPath,
		`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		const request = JSON.parse(line);
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { commands: [] } }) + "\\n");
	}
});
process.stdin.resume();
`,
	);
	return { cliPath, argvFile };
}

async function spawnedArgs(options: { provider?: string; model?: string }): Promise<string[]> {
	const { cliPath, argvFile } = writeArgvRecorder();
	const client = new RpcClient({ cliPath, ...options });
	await client.start();
	try {
		await client.getCommands();
		return JSON.parse(readFileSync(argvFile, "utf8")) as string[];
	} finally {
		await client.stop();
	}
}

async function hostModel(options: { provider?: string; model?: string }): Promise<{ provider: string; id: string }> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-rpc-client-default-model-"));
	tempDirs.push(agentDir);
	const model = (id: string) => ({
		id,
		api: "anthropic-messages",
		reasoning: true,
		contextWindow: 128000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const baseUrl = "http://127.0.0.1:9";
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[MOCK_PROVIDER]: {
					baseUrl,
					apiKey: MOCK_API_KEY,
					api: "anthropic-messages",
					models: [model(MOCK_MODEL), model(DEFAULT_MODEL)],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: MOCK_PROVIDER, defaultModel: DEFAULT_MODEL }),
	);
	const client = new RpcClient({
		cliPath: join(packageRoot, "src", "cli.ts"),
		cwd: packageRoot,
		env: {
			...hermeticProviderEnv(),
			ANTHROPIC_API_KEY: MOCK_API_KEY,
			PI_OFFLINE: "1",
			SENPI_CODING_AGENT_DIR: agentDir,
		},
		args: ["--no-session"],
		...options,
	});
	await client.start();
	try {
		const { model: selected } = await client.getState();
		if (!selected) throw new Error("the host reported no model");
		return { provider: selected.provider, id: selected.id };
	} finally {
		await client.stop();
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient provider and model arguments", () => {
	test("forwards --provider together with --model", async () => {
		const args = await spawnedArgs({ provider: "anthropic", model: "claude-test" });

		expect(args).toEqual(["--mode", "rpc", "--provider", "anthropic", "--model", "claude-test"]);
	});

	test("starts the host on its default model when only a provider is given", async () => {
		const args = await spawnedArgs({ provider: "anthropic" });

		expect(args).toEqual(["--mode", "rpc"]);
	});

	test("forwards a model without a provider", async () => {
		const args = await spawnedArgs({ model: "anthropic/claude-test" });

		expect(args).toEqual(["--mode", "rpc", "--model", "anthropic/claude-test"]);
	});
});

describe("RpcClient provider-only selection on a real RPC host (senpi#2576)", () => {
	test("a provider-only client runs on the host's configured default model", async () => {
		await expect(hostModel({ provider: MOCK_PROVIDER })).resolves.toEqual({
			provider: MOCK_PROVIDER,
			id: DEFAULT_MODEL,
		});
	}, 60_000);

	test("an explicit provider and model still select that model over the default", async () => {
		await expect(hostModel({ provider: MOCK_PROVIDER, model: MOCK_MODEL })).resolves.toEqual({
			provider: MOCK_PROVIDER,
			id: MOCK_MODEL,
		});
	}, 60_000);
});
