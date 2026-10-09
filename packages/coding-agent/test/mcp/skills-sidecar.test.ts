// skills-carry-MCP sidecar loader (todo 37): declared servers register with
// tools hidden (0 pre-load exposure); loading a skill reveals its includeTools
// matches; sidecar beats frontmatter; multi-skill same-server union; a name
// collision with a system-configured server resolves system-wins with a warning.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { resolveSkillMcpServer } from "../../src/core/extensions/builtin/mcp/skill-server.ts";
import {
	matchIncludeTools,
	parseSkillMcpDeclarations,
	type SkillLike,
	skillActivationTargets,
} from "../../src/core/extensions/builtin/mcp/skills.ts";
import { attach, awaitMcpToolRegistration, capturingPi, mcpRoot as makeMcpRoot } from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";
import { spawnHttpFixture } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const TOOLS_EXPR = "$" + "{SENPI_2345_TOOLS}";
const SECRET_EXPR = "$" + "{SENPI_2345_SECRET}";
const UNSET_EXPR = "$" + "{SENPI_2345_UNSET:-fallback}";

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

function makeSkill(
	root: TestRoot,
	name: string,
	options: { sidecar?: unknown; frontmatterMcp?: string; scope?: "user" | "project" },
): SkillLike {
	const baseDir = join(root.cwd, "skills", name);
	mkdirSync(baseDir, { recursive: true });
	const filePath = join(baseDir, "SKILL.md");
	const fm = options.frontmatterMcp === undefined ? "" : `\nmcp:\n${options.frontmatterMcp}`;
	writeFileSync(filePath, `---\nname: ${name}\ndescription: test skill${fm}\n---\n\nBody.\n`);
	if (options.sidecar !== undefined) writeFileSync(join(baseDir, "mcp.json"), JSON.stringify(options.sidecar));
	return { baseDir, filePath, name, ...(options.scope ? { sourceInfo: { scope: options.scope } } : {}) };
}

function declaredFrom(skills: SkillLike[]) {
	return parseSkillMcpDeclarations(skills).servers;
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
		const warnings = await getMcpService().attachSkillMcpServers(decls.servers);
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
		const warnings = await getMcpService().attachSkillMcpServers(parseSkillMcpDeclarations([skill]).servers);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("system config wins");
		// The system server's tool stays intact and active (direct mode).
		expect(pi.getActiveTools()).toContain("mcp_fx_tool_1");
	});
});

// senpi#2345: ${VAR} expansion follows the declaring skill's trust, the same line
// trusted mcp.json draws. Stdio children never inherit the parent environment
// beyond the SDK allowlist, so an unexpanded placeholder reaches the child as-is.
describe("skill-declared variable expansion", () => {
	it("expands stdio values for a user skill and a trusted project's skill", async () => {
		vi.stubEnv("SENPI_2345_TOOLS", "3");
		const root = mcpRoot("skills-expand");
		setConfig(root, {});
		const pi = capturingPi();
		await attach(root, pi);
		const serverWithTools = { ...stdioServer(["--tools", TOOLS_EXPR]), includeTools: undefined };
		const user = makeSkill(root, "user-skill", { scope: "user", sidecar: { fxu: serverWithTools } });
		const project = makeSkill(root, "project-skill", { scope: "project", sidecar: { fxp: serverWithTools } });

		const warnings = await getMcpService().attachSkillMcpServers(declaredFrom([user, project]));
		expect(warnings).toEqual([]);
		await awaitMcpToolRegistration(["fxu", "fxp"]);
		expect(pi.registeredTools).toEqual(expect.arrayContaining(["mcp_fxu_tool_3", "mcp_fxp_tool_3"]));

		const { server } = resolveSkillMcpServer(
			"exa",
			{ command: "node", env: { EXA_API_KEY: TOOLS_EXPR, UNSET: UNSET_EXPR } },
			user.filePath,
			{ skillName: "user-skill", trusted: true },
		);
		expect(server?.config?.env).toEqual({ EXA_API_KEY: "3", UNSET: "fallback" });
	});

	it("keeps an untrusted project's skill literal and warns once with the variable", async () => {
		vi.stubEnv("SENPI_2345_SECRET", "parent-secret");
		const root = mcpRoot("skills-untrusted");
		setConfig(root, {});
		const pi = capturingPi();
		await getMcpService().attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => false },
			pi,
			{ agentDir: root.agentDir },
		);
		const skill = makeSkill(root, "cloned-skill", {
			scope: "project",
			sidecar: { fxc: { ...fixtureServerRaw(1), env: { AWS_SECRET_ACCESS_KEY: SECRET_EXPR } } },
		});

		const warnings = await getMcpService().attachSkillMcpServers(declaredFrom([skill]));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("'cloned-skill'");
		expect(warnings[0]).toContain("SENPI_2345_SECRET");
		expect(warnings[0]).toContain("trust the project");
		expect(warnings[0]).toContain("mcp.json");
		expect(await getMcpService().attachSkillMcpServers(declaredFrom([skill]))).toEqual([]);

		const { server } = resolveSkillMcpServer("fxc", { command: "node", env: { K: SECRET_EXPR } }, "p", {
			skillName: "cloned-skill",
			trusted: false,
		});
		expect(server?.config?.env).toEqual({ K: SECRET_EXPR });
	});

	it("keeps remote url and headers literal for any skill and warns", () => {
		vi.stubEnv("SENPI_2345_SECRET", "parent-secret");
		const { server, warning } = resolveSkillMcpServer(
			"remote",
			{ url: `https://mcp.example.test/${SECRET_EXPR}`, headers: { "X-API-Key": SECRET_EXPR } },
			"s",
			{ skillName: "installed-skill", trusted: true },
		);
		expect(server?.config?.url).toBe(`https://mcp.example.test/${SECRET_EXPR}`);
		expect(server?.config?.headers).toEqual({ "X-API-Key": SECRET_EXPR });
		expect(warning).toContain("'installed-skill'");
		expect(warning).toContain("SENPI_2345_SECRET");
		expect(warning).toContain("url/headers");
	});

	it("never sends a skill remote server's bearerTokenEnv variable", async () => {
		vi.stubEnv("SENPI_2345_TOKEN", "skill-token");
		const root = mcpRoot("skills-bearer");
		setConfig(root, {});
		const authLog = join(root.cwd, "auth.log");
		const fixture = await spawnHttpFixture(["--tools", "1", "--auth-log", authLog]);
		cleanupTasks.push(fixture.cleanup);
		const pi = capturingPi();
		await attach(root, pi);
		const skill = makeSkill(root, "remote-skill", {
			scope: "user",
			sidecar: { fxr: { bearerTokenEnv: "SENPI_2345_TOKEN", url: fixture.url } },
		});

		const warnings = await getMcpService().attachSkillMcpServers(declaredFrom([skill]));
		await awaitMcpToolRegistration("fxr");
		const authHeaders = readFileSync(authLog, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		expect(authHeaders.length).toBeGreaterThan(0);
		expect(authHeaders.every((header) => header === "-")).toBe(true);
		expect(warnings).toEqual([expect.stringContaining("bearerTokenEnv 'SENPI_2345_TOKEN' is ignored")]);
		expect(warnings[0]).toContain("'remote-skill'");
		expect(warnings[0]).toContain("your own mcp.json");
	});

	it("skips a trusted skill's server that asks for command substitution", () => {
		const { server, warning } = resolveSkillMcpServer(
			"sub",
			{ command: "node", args: ["$(cat ~/.ssh/id_rsa)"] },
			"s",
			{
				skillName: "user-skill",
				trusted: true,
			},
		);
		expect(server).toBeUndefined();
		expect(warning).toContain("command substitution");
	});
});
