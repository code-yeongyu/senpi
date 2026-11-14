import { execFile } from "node:child_process";
import type { ProviderModelConfig } from "../../types.ts";
import { type CmdCliExecutableDeps, defaultCmdCliExecutableDeps, resolveCmdCliExecutable } from "./executable.ts";

export const STATIC_CMD_CLI_MODELS: ProviderModelConfig[] = [
	{
		id: "deepseek/deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash (Command Code)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5 (Command Code)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];

const ANSI_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// A catalog row is `id<2+ spaces>description`; headings, the Docs line and usage examples never match.
const MODEL_ROW_REGEX = /^([a-z0-9][a-z0-9._:/-]*) {2,}\S/;
const DECISION_MODELS_HEADING = /^Decision models\b/;

export function parseCmdCliModelsListing(rawOutput: string): ProviderModelConfig[] {
	const clean = rawOutput.replace(ANSI_REGEX, "");
	const lines = clean.split(/\r?\n/);
	const seen = new Set<string>();
	const models: ProviderModelConfig[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();
		// Decision models answer typed questions in headless mode only; they are not chat models.
		if (DECISION_MODELS_HEADING.test(line)) break;

		const id = line.match(MODEL_ROW_REGEX)?.[1];
		if (id === undefined || seen.has(id)) continue;
		seen.add(id);

		models.push({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
	}

	return models.length > 0 ? models : STATIC_CMD_CLI_MODELS;
}

export type CmdCliModelsRunner = (executable: string) => Promise<string>;

const defaultRunner: CmdCliModelsRunner = (executable: string): Promise<string> => {
	return new Promise((resolve, reject) => {
		execFile(executable, ["--list-models"], { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(stdout);
		});
	});
};

export type ResolveCmdCliModelsOptions = {
	readonly executable?: string;
	readonly executableDeps?: CmdCliExecutableDeps;
	readonly runner?: CmdCliModelsRunner;
};

export async function resolveCmdCliModels(options: ResolveCmdCliModelsOptions = {}): Promise<ProviderModelConfig[]> {
	try {
		const executable =
			options.executable ?? resolveCmdCliExecutable(options.executableDeps ?? defaultCmdCliExecutableDeps());
		const runner = options.runner ?? defaultRunner;
		const output = await runner(executable);
		return parseCmdCliModelsListing(output);
	} catch {
		return STATIC_CMD_CLI_MODELS;
	}
}
