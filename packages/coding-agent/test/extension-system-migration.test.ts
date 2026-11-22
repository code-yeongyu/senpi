import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const previousBrand = vi.hoisted(() => {
	const previous = process.env.SENPI_BRAND;
	process.env.SENPI_BRAND = JSON.stringify({ name: "OmO", configDir: ".omo", flatLayout: true });
	return previous;
});

import { ENV_AGENT_DIR } from "../src/config.ts";
import { migrateExtensionSystem } from "../src/extension-system-migration.ts";

describe("extension system migration", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterAll(() => {
		if (previousBrand === undefined) {
			delete process.env.SENPI_BRAND;
		} else {
			process.env.SENPI_BRAND = previousBrand;
		}
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function isolatedDirs(): { cwd: string; toolsDir: string } {
		const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-system-migration-"));
		tempDirs.push(rootDir);
		const cwd = path.join(rootDir, "project");
		const agentDir = path.join(rootDir, "agent");
		const toolsDir = path.join(cwd, ".omo", "tools");
		fs.mkdirSync(toolsDir, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		return { cwd, toolsDir };
	}

	it("does not warn for a plain OmO helper file", () => {
		const { cwd, toolsDir } = isolatedDirs();
		fs.writeFileSync(path.join(toolsDir, "helper.md"), "helper\n", "utf-8");

		expect(migrateExtensionSystem(cwd)).toEqual([]);
	});

	it("still warns for a legacy custom tool directory", () => {
		const { cwd, toolsDir } = isolatedDirs();
		const legacyToolDir = path.join(toolsDir, "weather");
		fs.mkdirSync(legacyToolDir);
		fs.writeFileSync(path.join(legacyToolDir, "index.ts"), "export default {};\n", "utf-8");

		expect(migrateExtensionSystem(cwd)).toEqual([
			"Project tools/ directory contains custom tools. Custom tools have been merged into extensions.",
		]);
	});
});
