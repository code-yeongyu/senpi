import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "../../../../config.js";
import { parseFrontmatter } from "../../../../utils/frontmatter.js";
import { type AgentFrontmatter, type AgentInfo, validateAgentConfig } from "./agent-types.js";

async function scanDir(dir: string, files: string[]): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await scanDir(fullPath, files);
		} else if (entry.name.endsWith(".md")) {
			files.push(fullPath);
		}
	}
}

async function scanMarkdownFiles(baseDir: string): Promise<string[]> {
	const files: string[] = [];
	for (const subdir of ["agent", "agents"]) {
		const dir = path.join(baseDir, subdir);
		try {
			await scanDir(dir, files);
		} catch {
			// directory doesn't exist, skip
		}
	}
	return files;
}

export async function loadAgentsFromDirectory(dir: string): Promise<Record<string, AgentInfo>> {
	const agents: Record<string, AgentInfo> = {};
	const files = await scanMarkdownFiles(dir);

	for (const file of files) {
		const name = path.basename(file, ".md");
		try {
			const content = await fs.readFile(file, "utf-8");
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
			const result = validateAgentConfig(name, frontmatter, body);
			if (result instanceof Error) {
				process.stderr.write(`Warning: skipping agent "${name}" from ${file}: ${result.message}\n`);
				continue;
			}
			agents[name] = result;
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown error";
			process.stderr.write(`Warning: failed to load agent "${name}" from ${file}: ${message}\n`);
		}
	}

	return agents;
}

export async function loadAllAgents(cwd: string, homeDir: string = os.homedir()): Promise<Record<string, AgentInfo>> {
	const globalAgents = await loadAgentsFromDirectory(path.join(homeDir, CONFIG_DIR_NAME));
	const localAgents = await loadAgentsFromDirectory(path.join(cwd, CONFIG_DIR_NAME));
	return { ...globalAgents, ...localAgents };
}
