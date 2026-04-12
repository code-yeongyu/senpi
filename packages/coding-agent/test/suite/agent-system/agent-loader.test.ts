import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentsFromDirectory, loadAllAgents } from "../../../src/core/extensions/builtin/agent-system/loader.js";

describe("loadAgentsFromDirectory", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loader-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("loads valid agent from agents subdirectory", async () => {
		// given
		const agentsDir = path.join(tmpDir, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "test-agent.md"),
			`---
description: A test agent
mode: subagent
model: claude-sonnet-4
---
You are a test agent.`,
		);

		// when
		const result = await loadAgentsFromDirectory(tmpDir);

		// then
		expect(result["test-agent"]).toBeDefined();
		expect(result["test-agent"]!.name).toBe("test-agent");
		expect(result["test-agent"]!.description).toBe("A test agent");
		expect(result["test-agent"]!.mode).toBe("subagent");
		expect(result["test-agent"]!.model).toBe("claude-sonnet-4");
		expect(result["test-agent"]!.prompt).toBe("You are a test agent.");
		expect(result["test-agent"]!.native).toBe(false);
	});

	it("loads valid agent from agent subdirectory", async () => {
		// given
		const agentDir = path.join(tmpDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "my-agent.md"),
			`---
description: My agent
mode: primary
---
Do things.`,
		);

		// when
		const result = await loadAgentsFromDirectory(tmpDir);

		// then
		expect(result["my-agent"]).toBeDefined();
		expect(result["my-agent"]!.mode).toBe("primary");
	});

	it("returns empty map when directory does not exist", async () => {
		// given
		const nonExistentDir = path.join(tmpDir, "does-not-exist");

		// when
		const result = await loadAgentsFromDirectory(nonExistentDir);

		// then
		expect(result).toEqual({});
	});

	it("skips agent with invalid YAML frontmatter", async () => {
		// given
		const agentsDir = path.join(tmpDir, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "bad-agent.md"),
			`---
mode: totally-invalid-mode
temperature: 999
---
Bad agent.`,
		);

		// when
		const result = await loadAgentsFromDirectory(tmpDir);

		// then
		expect(result).toEqual({});
	});

	it("derives agent name from filename stripping path and extension", async () => {
		// given
		const nestedDir = path.join(tmpDir, "agents", "subdir");
		await fs.mkdir(nestedDir, { recursive: true });
		await fs.writeFile(
			path.join(nestedDir, "nested-agent.md"),
			`---
description: Nested agent
---
Nested prompt.`,
		);

		// when
		const result = await loadAgentsFromDirectory(tmpDir);

		// then
		expect(result["nested-agent"]).toBeDefined();
		expect(result["nested-agent"]!.name).toBe("nested-agent");
	});

	it("loads agents from both agent and agents subdirectories", async () => {
		// given
		const agentDir = path.join(tmpDir, "agent");
		const agentsDir = path.join(tmpDir, "agents");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "alpha.md"),
			`---
description: Alpha
---
Alpha prompt.`,
		);
		await fs.writeFile(
			path.join(agentsDir, "beta.md"),
			`---
description: Beta
---
Beta prompt.`,
		);

		// when
		const result = await loadAgentsFromDirectory(tmpDir);

		// then
		expect(result.alpha).toBeDefined();
		expect(result.beta).toBeDefined();
	});
});

describe("loadAllAgents", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loader-all-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("merges project-local over global with project winning on name conflict", async () => {
		// given
		const fakeHome = path.join(tmpDir, "home");
		const projectDir = path.join(tmpDir, "project");
		const globalAgentsDir = path.join(fakeHome, ".senpi", "agents");
		const localAgentsDir = path.join(projectDir, ".senpi", "agents");
		await fs.mkdir(globalAgentsDir, { recursive: true });
		await fs.mkdir(localAgentsDir, { recursive: true });

		await fs.writeFile(
			path.join(globalAgentsDir, "shared.md"),
			`---
description: Global version
mode: subagent
---
Global prompt.`,
		);
		await fs.writeFile(
			path.join(globalAgentsDir, "global-only.md"),
			`---
description: Global only agent
---
Global only prompt.`,
		);
		await fs.writeFile(
			path.join(localAgentsDir, "shared.md"),
			`---
description: Local version
mode: primary
---
Local prompt.`,
		);

		// when
		const result = await loadAllAgents(projectDir, fakeHome);

		// then
		expect(result.shared).toBeDefined();
		expect(result.shared!.description).toBe("Local version");
		expect(result.shared!.mode).toBe("primary");
		expect(result["global-only"]).toBeDefined();
		expect(result["global-only"]!.description).toBe("Global only agent");
	});
});
