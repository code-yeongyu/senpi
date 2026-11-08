import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ContextFile, loadProjectContextFiles } from "../../../src/core/context-files.ts";

// issue #5567: `contextFiles.globalPath` replaces the agent-dir probe for the global (user-scope)
// context file. Precedence is defined and never errors: unset/blank keeps the agent-dir file; a set
// but missing, unreadable, or candidate-less target falls back to the agent-dir probe. An explicit
// file keeps `scope: "user"`, dedupes against the ancestor walk, and rides the same size limits.
const tempDirs: string[] = [];

function workspace(): { cwd: string; agentDir: string; globalDir: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-5567-"));
	tempDirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const globalDir = join(root, "agents-home", ".agents");
	for (const dir of [cwd, agentDir, globalDir]) mkdirSync(dir, { recursive: true });
	return { cwd, agentDir, globalDir };
}

function writeFile(path: string, content: string): string {
	writeFileSync(path, content);
	return path;
}

/** The ancestor walk reaches real parent directories (up to the drive root on Windows); target by path. */
function findByPath(files: ContextFile[], path: string): ContextFile | undefined {
	return files.find((file) => file.path === path);
}

describe("issue #5567: configurable global context-file path", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
	});

	it("loads the explicit globalPath file instead of the agent-dir file", () => {
		const { cwd, agentDir, globalDir } = workspace();
		writeFile(join(agentDir, "AGENTS.md"), "agent dir instructions");
		const explicit = writeFile(join(globalDir, "shared-rules.md"), "explicit global instructions");

		const files = loadProjectContextFiles({ cwd, agentDir, globalPath: explicit });

		const globalFile = findByPath(files, explicit);
		expect(globalFile?.content).toBe("explicit global instructions");
		expect(globalFile?.scope).toBe("user");
		expect(findByPath(files, join(agentDir, "AGENTS.md"))).toBeUndefined();
	});

	it("uses the agent-dir file when globalPath is unset or blank", () => {
		const { cwd, agentDir } = workspace();
		const agentFile = writeFile(join(agentDir, "AGENTS.md"), "agent dir instructions");

		for (const globalPath of [undefined, "", "   "]) {
			const files = loadProjectContextFiles({ cwd, agentDir, globalPath });
			expect(findByPath(files, agentFile)?.content).toBe("agent dir instructions");
			expect(findByPath(files, agentFile)?.scope).toBe("user");
		}
	});

	it("falls back to the agent-dir file when globalPath is set but missing, without erroring", () => {
		const { cwd, agentDir, globalDir } = workspace();
		const agentFile = writeFile(join(agentDir, "AGENTS.md"), "agent dir instructions");

		const files = loadProjectContextFiles({ cwd, agentDir, globalPath: join(globalDir, "gone.md") });

		expect(findByPath(files, agentFile)?.content).toBe("agent dir instructions");
	});

	it("probes the usual candidates when globalPath is a directory", () => {
		const { cwd, agentDir, globalDir } = workspace();
		writeFile(join(agentDir, "AGENTS.md"), "agent dir instructions");
		const override = writeFile(join(globalDir, "AGENTS.override.md"), "override instructions");
		writeFile(join(globalDir, "AGENTS.md"), "plain instructions");

		const files = loadProjectContextFiles({ cwd, agentDir, globalPath: globalDir });

		expect(findByPath(files, override)?.content).toBe("override instructions");
		expect(findByPath(files, override)?.scope).toBe("user");
		expect(findByPath(files, join(globalDir, "AGENTS.md"))).toBeUndefined();
		expect(findByPath(files, join(agentDir, "AGENTS.md"))).toBeUndefined();
	});

	it("falls back to the agent-dir file when globalPath is a candidate-less directory", () => {
		const { cwd, agentDir, globalDir } = workspace();
		const agentFile = writeFile(join(agentDir, "AGENTS.md"), "agent dir instructions");
		writeFile(join(globalDir, "README.md"), "not a context candidate");

		const files = loadProjectContextFiles({ cwd, agentDir, globalPath: globalDir });

		expect(findByPath(files, agentFile)?.content).toBe("agent dir instructions");
	});

	it("applies the same size limits to the explicit global file", () => {
		const { cwd, agentDir, globalDir } = workspace();
		const line = "- Rule: keep the invariants of this subsystem and record the change in the ledger.\n";
		const explicit = writeFile(join(globalDir, "AGENTS.md"), `# Global rules\n${line.repeat(200)}`);

		const files = loadProjectContextFiles({ cwd, agentDir, globalPath: explicit, maxBytesPerFile: 4096 });

		const globalFile = findByPath(files, explicit);
		expect(globalFile).toBeDefined();
		expect(Buffer.byteLength(globalFile?.content ?? "", "utf8")).toBeLessThanOrEqual(4096);
		expect(globalFile?.content).toContain("truncated");
		expect(globalFile?.content.startsWith("# Global rules\n")).toBe(true);
		expect(files.diagnostics).toContainEqual(
			expect.objectContaining({ type: "warning", category: "size-limit", path: explicit }),
		);
	});

	it("deduplicates an explicit global file that the ancestor walk also reaches", () => {
		const { cwd, agentDir } = workspace();
		writeFile(join(agentDir, "AGENTS.md"), "agent dir instructions");
		const explicit = writeFile(join(cwd, "AGENTS.md"), "shared project and global instructions");

		const files = loadProjectContextFiles({ cwd, agentDir, globalPath: explicit });

		const matches = files.filter((file) => file.path === explicit);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.scope).toBe("user");
	});
});
