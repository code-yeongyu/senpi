import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

const roots: string[] = [];
const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
	{ label: "print", mode: "text" },
	{ label: "JSON", mode: "json" },
	{ label: "RPC", mode: "rpc" },
])(
	"$label prints size warnings once without exposing skill validation warnings",
	async ({ mode }) => {
		// Given: real resource loading produces both budget warnings and a legacy validation warning.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-3460-stderr-")));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const invalidSkillDir = join(agentDir, "skills", "invalid-name");
		const invalidSkillPath = join(invalidSkillDir, "SKILL.md");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const contextPath = join(cwd, "AGENTS.md");
		writeFileSync(contextPath, "x".repeat(4096));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				contextFiles: { maxBytesPerFile: 1024, maxTotalBytes: 2048 },
				disabledBuiltinExtensions: ["codemode"],
				defaultProvider: "qa-local",
				defaultModel: "qa-model",
			}),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"qa-local": {
						baseUrl: "http://127.0.0.1:1",
						apiKey: "synthetic-qa-key",
						api: "anthropic-messages",
						models: [
							{
								id: "qa-model",
								reasoning: false,
								contextWindow: 128000,
								maxTokens: 4096,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		);
		for (let index = 0; index < 101; index++) {
			const dir = join(agentDir, "skills", `skill-${index}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: skill-${index}\ndescription: Synthetic QA skill.\n---\n`);
		}
		mkdirSync(invalidSkillDir);
		writeFileSync(invalidSkillPath, "---\nname: Invalid_Name\ndescription: Synthetic invalid-name skill.\n---\n");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noThemes: true,
			noPromptTemplates: true,
		});
		await loader.reload();
		const validation = loader.getSkills().diagnostics.find((diagnostic) => diagnostic.path === invalidSkillPath);
		expect(validation).toMatchObject({ type: "warning" });
		if (!validation) throw new Error("The legacy validation warning fixture was not loaded");
		const contextWarning = loader.getAgentsFiles().diagnostics[0];
		expect(contextWarning).toMatchObject({ type: "warning", path: contextPath });
		if (!contextWarning) throw new Error("The context size warning fixture was not loaded");
		const catalogWarning = loader.getSkills().diagnostics.find((diagnostic) => diagnostic.path === undefined);
		expect(catalogWarning).toMatchObject({ type: "warning" });
		if (!catalogWarning) throw new Error("The catalog size warning fixture was not loaded");

		// When: run the actual CLI with closed stdin and no prompt, so no provider request is made.
		const stderr = await new Promise<string>((resolve, reject) => {
			const child = execFile(
				"bun",
				[
					cli,
					"--offline",
					"--no-session",
					"--no-extensions",
					"--no-themes",
					"--no-prompt-templates",
					"--mode",
					mode,
				],
				{
					cwd,
					timeout: 20_000,
					env: {
						PATH: process.env.PATH,
						HOME: root,
						TMPDIR: process.env.TMPDIR,
						NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
						BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
						SENPI_CODING_AGENT_DIR: agentDir,
						PI_OFFLINE: "1",
					},
				},
				(error, _stdout, output) => (error ? reject(error) : resolve(output)),
			);
			child.stdin?.end();
		});

		// Then: each budget warning is emitted once, with paths retained, and legacy warnings stay silent.
		expect(stderr).not.toContain(validation.message);
		const lines = stderr.split("\n");
		expect(lines.filter((line) => line.includes(contextWarning.message))).toHaveLength(1);
		expect(lines.filter((line) => line.includes(catalogWarning.message))).toHaveLength(1);
		expect(lines.find((line) => line.includes(contextWarning.message))).toContain(contextPath);
	},
	30_000,
);
