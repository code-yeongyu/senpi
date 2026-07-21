// skills-carry-MCP sidecar loader (todo 37): declared servers register with
// tools hidden (0 pre-load exposure); loading a skill reveals its includeTools
// matches; sidecar beats frontmatter; multi-skill same-server union; a name
// collision with a system-configured server resolves system-wins with a warning.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	matchIncludeTools,
	parseSkillMcpDeclarations,
	type SkillLike,
	skillActivationTargets,
} from "../../src/core/extensions/builtin/mcp/skills.ts";
import { attach, awaitMcpToolRegistration, capturingPi, mcpRoot as makeMcpRoot } from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

function makeSkill(root: TestRoot, name: string, options: { sidecar?: unknown; frontmatterMcp?: string }): SkillLike {
	const baseDir = join(root.cwd, "skills", name);
	mkdirSync(baseDir, { recursive: true });
	const filePath = join(baseDir, "SKILL.md");
	const fm = options.frontmatterMcp === undefined ? "" : `\nmcp:\n${options.frontmatterMcp}`;
	writeFileSync(filePath, `---\nname: ${name}\ndescription: test skill${fm}\n---\n\nBody.\n`);
	if (options.sidecar !== undefined) writeFileSync(join(baseDir, "mcp.json"), JSON.stringify(options.sidecar));
	return { baseDir, filePath, name };
}

function fixtureServerRaw(tools: number): Record<string, unknown> {
	const base = stdioServer(["--tools", String(tools)]);
	return { ...base, includeTools: undefined };
}

describe("skills-carry-MCP declarations", () => {
	it("parses frontmatter-only skills and lets a sidecar win over frontmatter", () => {
		const root = mcpRoot("skills-parse");
		const fmOnly = makeSkill(root, "fm-only", {
			frontmatterMcp: `  fmsrv:\n    type: stdio\n    command: node\n    args: ["x"]`,
		});
		const both = makeSkill(root, "both", {
			frontmatterMcp: `  losersrv:\n    command: node`,
			sidecar: { winsrv: { args: ["y"], command: "node", type: "stdio" } },
		});
		const decls = parseSkillMcpDeclarations([fmOnly, both]);
		expect([...decls.servers.keys()].sort()).toEqual(["fmsrv", "winsrv"]);
		expect(decls.servers.get("winsrv")?.sourcePath.endsWith("mcp.json")).toBe(true);
		expect(decls.warnings).toEqual([]);
	});

	it("union-merges includeTools when two skills declare the same server", () => {
		const root = mcpRoot("skills-union");
		const a = makeSkill(root, "skill-a", { sidecar: { shared: { command: "node", includeTools: ["tool_1"] } } });
		const b = makeSkill(root, "skill-b", { sidecar: { shared: { command: "node", includeTools: ["tool_2*"] } } });
		const decls = parseSkillMcpDeclarations([a, b]);
		const registered = [
			{ name: "mcp_shared_tool_1", server: "shared", toolName: "tool_1" },
			{ name: "mcp_shared_tool_2", server: "shared", toolName: "tool_2" },
			{ name: "mcp_shared_tool_3", server: "shared", toolName: "tool_3" },
		];
		expect(skillActivationTargets(decls, "skill-a", registered)).toEqual(["mcp_shared_tool_1"]);
		expect(skillActivationTargets(decls, "skill-b", registered)).toEqual(["mcp_shared_tool_2"]);
		expect(matchIncludeTools(["*"], "anything")).toBe(true);
	});
});

describe("skills-carry-MCP live registration", () => {
	it("registers hidden until activation, then reveals includeTools matches", async () => {
		const root = mcpRoot("skills-live");
		setConfig(root, {});
		const pi = capturingPi();
		await attach(root, pi);

		const skill = makeSkill(root, "carrier", {
			sidecar: { fx2: { ...fixtureServerRaw(3), includeTools: ["tool_1", "tool_3"] } },
		});
		const decls = parseSkillMcpDeclarations([skill]);
		const declared = new Map(
			[...decls.servers].map(([name, decl]) => [name, { raw: decl.raw, sourcePath: decl.sourcePath }]),
		);
		const warnings = await getMcpService().attachSkillMcpServers(declared);
		expect(warnings).toEqual([]);
		await awaitMcpToolRegistration("fx2");

		// 0 exposure pre-load: catalog registered, nothing active.
		const active = pi.getActiveTools();
		expect(pi.registeredTools).toContain("mcp_fx2_tool_1");
		expect(active.filter((name) => name.startsWith("mcp_fx2_"))).toEqual([]);

		const targets = skillActivationTargets(decls, "carrier", getMcpService().getTierBSearchable());
		expect(targets).toEqual(["mcp_fx2_tool_1", "mcp_fx2_tool_3"]);
		getMcpService().activateSkillMcpTools(targets);
		const revealed = pi.getActiveTools().filter((name) => name.startsWith("mcp_fx2_"));
		expect(revealed).toEqual(["mcp_fx2_tool_1", "mcp_fx2_tool_3"]);
	});

	it("keeps the system config and warns on a server-name collision", async () => {
		const root = mcpRoot("skills-collision");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");

		const skill = makeSkill(root, "clasher", { sidecar: { fx: { command: "node", args: ["evil"] } } });
		const decls = parseSkillMcpDeclarations([skill]);
		const declared = new Map(
			[...decls.servers].map(([name, decl]) => [name, { raw: decl.raw, sourcePath: decl.sourcePath }]),
		);
		const warnings = await getMcpService().attachSkillMcpServers(declared);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("system config wins");
		// The system server's tool stays intact and active (direct mode).
		expect(pi.getActiveTools()).toContain("mcp_fx_tool_1");
	});
});
