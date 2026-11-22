// #3796: exercise the service's real stdio transport, not an env-builder mock.
/* oxlint-disable eslint/no-template-curly-in-string -- these tests feed literal MCP config text such as "${TOKEN}" to the interpolation under test. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { fakePi } from "../../mcp/fixtures/service-lifecycle.ts";
import { createTestUiContext } from "../harness.ts";

let root: string;
let service: McpService;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "senpi-3796-env-"));
	mkdirSync(join(root, "agent"), { recursive: true });
	vi.stubEnv("HOME", root);
	service = new McpService();
});

it("offers one permanent grant before spawn and restores only its referenced name", async () => {
	vi.stubEnv("ODD_DSN", "synthetic-dsn");
	vi.stubEnv("ODD_COOKIE", "synthetic-cookie");
	const receipt = join(root, "grant-receipt.json");
	const fixture = fileURLToPath(new URL("../../mcp/fixtures/stdio-server.ts", import.meta.url));
	const script = [
		`import {writeFileSync} from "node:fs";`,
		`writeFileSync(${JSON.stringify(receipt)},JSON.stringify({reference:process.env.REF,cookie:process.env.ODD_COOKIE}));`,
		`await import(${JSON.stringify(fixture)});`,
	].join("");
	const decisions: string[][] = [];
	service.setMcpElicitationUiProvider(() =>
		createTestUiContext({
			select: async (_title, options) => {
				decisions.push(options);
				return "Grant and save permanently";
			},
		}),
	);
	const pi = fakePi();
	await service.attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root, mode: "tui", isProjectTrusted: () => false },
		pi,
		{ agentDir: join(root, "agent") },
	);
	const sourcePath = join(root, "SKILL.md");
	writeFileSync(sourcePath, "---\nname: carrier\ndescription: test\n---\n");
	const declaration = new Map([
		[
			"probe",
			{
				raw: { command: process.execPath, args: ["-e", script], env: { REF: "${ODD_DSN}" } },
				scope: "project" as const,
				skillName: "carrier",
				sourcePath,
			},
		],
	]);
	await Promise.all([service.attachSkillMcpServers(declaration, pi), service.attachSkillMcpServers(declaration, pi)]);
	const connection = service.getConnection("probe");
	if (!connection) throw new Error("missing project connection");
	await connection.connect();
	expect(decisions).toEqual([["Grant and save permanently", "Start without them"]]);
	expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ reference: "synthetic-dsn" });
	const saved = readFileSync(join(root, "agent", "mcp-env-grants.json"), "utf8");
	expect(saved).toContain("ODD_DSN");
	expect(saved).not.toContain("synthetic-dsn");
	expect(saved).not.toContain("synthetic-cookie");
});
afterEach(async () => {
	await service.dispose("quit");
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

it("passes finite project base and explicit env while withholding ungranted references", async () => {
	vi.stubEnv("XDG_DATA_HOME", "/synthetic/data");
	vi.stubEnv("LC_SECRET", "synthetic-private");
	vi.stubEnv("ODD_DSN", "synthetic-dsn");
	const receipt = join(root, "receipt.json");
	const fixture = fileURLToPath(new URL("../../mcp/fixtures/stdio-server.ts", import.meta.url));
	const script = [
		`import {writeFileSync} from "node:fs";`,
		`writeFileSync(${JSON.stringify(receipt)},JSON.stringify({`,
		`base:process.env.XDG_DATA_HOME,secret:process.env.LC_SECRET,`,
		`reference:process.env.REF,explicit:process.env.CALLER_VALUE}));`,
		`await import(${JSON.stringify(fixture)});`,
	].join("");
	const pi = fakePi();
	await service.attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root, isProjectTrusted: () => false },
		pi,
		{ agentDir: join(root, "agent"), env: { CALLER_VALUE: "synthetic-caller" } },
	);
	const sourcePath = join(root, "SKILL.md");
	writeFileSync(sourcePath, "---\nname: carrier\ndescription: test\n---\n");
	const warnings = await service.attachSkillMcpServers(
		new Map([
			[
				"probe",
				{
					raw: { command: process.execPath, args: ["-e", script], env: { REF: "${ODD_DSN}" } },
					scope: "project" as const,
					skillName: "carrier",
					sourcePath,
				},
			],
		]),
		pi,
	);
	const connection = service.getConnection("probe");
	if (!connection) throw new Error("missing project connection");
	await connection.connect();
	expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
		base: "/synthetic/data",
		reference: "${ODD_DSN}",
		explicit: "synthetic-caller",
	});
	expect(warnings.join("\n")).toContain("ODD_DSN");
	expect(warnings.join("\n")).not.toContain("synthetic-dsn");
});

// #3858 x #3796: the project environment policy materializes plain strings only, so a project skill server that
// declares a reference object is refused with the named error before any read, even in a trusted project.
it("skips a trusted project skill server that declares a reference object", async () => {
	const pi = fakePi();
	await service.attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root, isProjectTrusted: () => true },
		pi,
		{ agentDir: join(root, "agent") },
	);
	const sourcePath = join(root, "SKILL.md");
	writeFileSync(sourcePath, "---\nname: carrier\ndescription: test\n---\n");
	const warnings = await service.attachSkillMcpServers(
		new Map([
			[
				"probe",
				{
					raw: { command: process.execPath, env: { TOKEN: { $file: join(root, "unread-secret") } } },
					scope: "project" as const,
					skillName: "carrier",
					sourcePath,
				},
			],
		]),
		pi,
	);
	expect(service.getConnection("probe")).toBeUndefined();
	expect(warnings.join("\n")).toContain("Skill 'carrier' MCP server 'probe' skipped");
	expect(warnings.join("\n")).toContain("forbidden");
});

// #3858 merge delta review: the connection identity keeps the project declaration's hash, so an env-only edit of a
// project skill server re-keys it and the next connect runs the new declaration.
it("reconnects a project skill server with its edited env", async () => {
	const receipt = join(root, "edit-receipt.json");
	const fixture = fileURLToPath(new URL("../../mcp/fixtures/stdio-server.ts", import.meta.url));
	const script = [
		`import {writeFileSync} from "node:fs";`,
		`writeFileSync(${JSON.stringify(receipt)},JSON.stringify({ref:process.env.REF}));`,
		`await import(${JSON.stringify(fixture)});`,
	].join("");
	const pi = fakePi();
	await service.attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root, isProjectTrusted: () => true },
		pi,
		{ agentDir: join(root, "agent") },
	);
	const sourcePath = join(root, "SKILL.md");
	writeFileSync(sourcePath, "---\nname: carrier\ndescription: test\n---\n");
	const declare = (ref: string) =>
		new Map([
			[
				"probe",
				{
					raw: { command: process.execPath, args: ["-e", script], env: { REF: ref } },
					scope: "project" as const,
					skillName: "carrier",
					sourcePath,
				},
			],
		]);
	await service.attachSkillMcpServers(declare("lit1"), pi);
	const first = service.getConnection("probe");
	if (!first) throw new Error("missing project connection");
	await first.connect();
	expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ ref: "lit1" });
	await service.attachSkillMcpServers(declare("lit2"), pi);
	await service.reconnectServer("probe");
	const second = service.getConnection("probe");
	if (!second) throw new Error("missing re-keyed connection");
	expect(second).not.toBe(first);
	await second.connect();
	expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ ref: "lit2" });
});
