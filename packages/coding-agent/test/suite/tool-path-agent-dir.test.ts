import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brandEnvNames } from "../../src/core/brand.ts";

// Every name getAgentDir() reads, so the test's directory wins whatever the inherited environment holds.
const AGENT_DIR_ENV = brandEnvNames("CODING_AGENT_DIR");

// senpi#5603 review: the built-in shell tools never touch the agent dir. The tool path records no scope token, writes
// no file and adds no scope variable to the command's environment, so a read-only agent dir cannot break bash.

// The tools fall back to their factory cwd and skip session metadata when no extension context is passed.
const NO_CONTEXT = undefined as never;

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

// The process-wide tool machine is created on first use, so each case loads the tools fresh after pointing the agent
// dir at its own directory.
async function freshTools(cwd: string) {
	vi.resetModules();
	const { createAllToolDefinitions } = await import("../../src/core/tools/index.ts");
	return createAllToolDefinitions(cwd);
}

describe.runIf(process.platform !== "win32")("tool path leaves the agent dir alone (senpi#5603)", () => {
	let base: string;
	let agentDir: string;
	let cwd: string;
	let previous: Map<string, string | undefined>;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "tool-path-agent-dir-"));
		agentDir = join(base, "agent");
		cwd = join(base, "cwd");
		for (const dir of [agentDir, cwd]) mkdirSync(dir);
		previous = new Map(AGENT_DIR_ENV.map((name) => [name, process.env[name]]));
		for (const name of AGENT_DIR_ENV) process.env[name] = agentDir;
	});

	afterEach(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		chmodSync(agentDir, 0o755);
		rmSync(base, { recursive: true, force: true });
	});

	it("bash returns its output when the agent dir is read-only", async () => {
		chmodSync(agentDir, 0o555);
		const tools = await freshTools(cwd);
		const result = await tools.bash.execute("b", { command: "echo hello" }, undefined, undefined, NO_CONTEXT);
		expect(textOf(result).trim()).toBe("hello");
	});

	it("bash writes nothing under the agent dir and adds no scope variable", async () => {
		const tools = await freshTools(cwd);
		const result = await tools.bash.execute("b", { command: "env; echo END" }, undefined, undefined, NO_CONTEXT);
		const output = textOf(result);
		expect(output).toContain("END");
		expect(output).not.toContain("MACHINE_SCOPE=");
		expect(readdirSync(agentDir, { recursive: true })).toEqual([]);
	});
});
