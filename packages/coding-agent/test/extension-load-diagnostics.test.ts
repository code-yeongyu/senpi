import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { collectExtensionLoadDiagnostics } from "../src/main.ts";

describe("extension load diagnostics", () => {
	let originalAgentDir: string | undefined;
	let originalCwd = process.cwd();
	let originalExitCode: typeof process.exitCode = process.exitCode;
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "senpi-extension-diagnostics-"));
		tempDirs.push(dir);
		return dir;
	}

	it("downgrades extension load failures to startup warnings", async () => {
		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		const brokenExtensionPath = join(extensionsDir, "broken.js");
		writeFileSync(brokenExtensionPath, "throw new Error('missing dependency');\n");
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		process.chdir(projectDir);

		const services = await createAgentSessionServices({ cwd: projectDir, agentDir });
		const extensionErrors = services.resourceLoader.getExtensions().errors;
		expect(extensionErrors).toHaveLength(1);

		const diagnostics = collectExtensionLoadDiagnostics(extensionErrors);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				message: expect.stringContaining(`Failed to load extension "${brokenExtensionPath}"`),
			},
		]);
		expect(diagnostics[0]?.message).toContain("missing dependency");
	});
});
