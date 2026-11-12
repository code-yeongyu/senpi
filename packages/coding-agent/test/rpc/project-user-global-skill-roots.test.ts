/**
 * senpi#6558 review: which roots the project verbs refuse as user-global. The refusal holds the real skill roots the
 * engine loads with user provenance, never a whole package folder: a project that is itself a globally installed
 * local package (or loaded with `-e .`) keeps its own instruction file, MCP file and project skills, while the
 * package's skills stay refused. Skill paths added by an extension or on the command line are user-global roots too,
 * a loader without the optional `getUserSkillRoots` still has the agent dir and `~/.agents/skills` refused, and a
 * root that does not exist yet is compared through its nearest existing parent's real path (a `$HOME` behind a link).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import {
	disposeFolderHosts,
	type FolderHost,
	PROJECT_CONFIG_DIR,
	SKILL_NAME,
	skillSource,
	startFolderHost,
} from "./project-folder-verbs-host.ts";

const PACKAGE_SKILL = "pkg-skill";
const DEV_SKILL = "dev-skill";
const HOME_SKILL = "ugr-home-skill";
const AGENT_CONTEXT = `${PROJECT_CONFIG_DIR}/agent/AGENTS.md`;
const SERVER = { command: "node", args: ["server.js"] };
const NOT_ALLOWED = { success: false, errorCode: "project_file_not_allowed" };

const etagOf = (content: string): string => `sha256-${createHash("sha256").update(content).digest("hex")}`;

function writeSkill(root: string, name: string): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), skillSource(name));
}

/** A session opened in `$HOME` (the scratch folder is both cwd and `HOME`), as in project-user-global-refusal. */
function startHomeHost(
	options: Omit<Parameters<typeof startFolderHost>[0] & object, "layout" | "prepare"> & {
		readonly prepare?: (home: string) => void;
	} = {},
): Promise<FolderHost> {
	return startFolderHost({
		stubHome: true,
		...options,
		layout: (scratch) => ({ cwd: scratch, agentDir: join(scratch, PROJECT_CONFIG_DIR, "agent") }),
		prepare: (layout) => options.prepare?.(layout.cwd),
	});
}

afterEach(disposeFolderHosts);

describe("project verbs: a project that is itself a user-scoped package keeps its own files (senpi#6558)", () => {
	it.each([
		{ name: "installed globally from its local path", settings: (cwd: string) => ({ packages: [cwd] }), args: [] },
		{ name: "loaded with -e .", settings: () => ({}), args: ["-e", "."] },
	])("$name: its instruction file, MCP file and project skill work, its package skill is refused", async (variant) => {
		const host = await startFolderHost({
			settings: ({ cwd }) => variant.settings(cwd),
			args: variant.args,
			prepare: ({ cwd }) => writeSkill(join(cwd, "skills"), PACKAGE_SKILL),
		});
		await host.trust();

		expect(
			await host.call("write_project_file", { path: "AGENTS.md", content: "# Rules\n", ifEtag: null }),
		).toMatchObject({ success: true });
		expect(await host.call("read_project_file", { path: "AGENTS.md" })).toMatchObject({
			success: true,
			data: { exists: true, content: "# Rules\n" },
		});
		expect(await host.call("set_project_mcp_servers", { patch: { alpha: SERVER }, ifEtag: null })).toMatchObject({
			success: true,
		});
		expect(await host.call("get_project_mcp_servers")).toMatchObject({
			success: true,
			data: { mcpServers: { alpha: SERVER } },
		});
		const skill = await host.call("read_project_skill_file", { skill: SKILL_NAME });
		expect(skill).toMatchObject({ success: true, data: { exists: true } });
		expect(
			await host.call("write_project_skill_file", {
				skill: SKILL_NAME,
				content: skillSource(SKILL_NAME, "Edited."),
				ifEtag: (skill.data as { etag: string }).etag,
			}),
		).toMatchObject({ success: true });

		expect(await host.call("read_project_skill_file", { skill: PACKAGE_SKILL })).toMatchObject(NOT_ALLOWED);
		expect(
			await host.call("write_project_skill_file", {
				skill: PACKAGE_SKILL,
				content: skillSource(PACKAGE_SKILL, "Pwned."),
				ifEtag: etagOf(skillSource(PACKAGE_SKILL)),
			}),
		).toMatchObject(NOT_ALLOWED);
	});
});

describe("project verbs: skill paths added at run time are user-global roots (senpi#6558)", () => {
	it("refuses a skill under $HOME that an extension adds through resources_discover", async () => {
		let home = "";
		const host = await startHomeHost({
			prepare: (scratch) => {
				home = scratch;
				writeSkill(join(scratch, "dev-skills"), DEV_SKILL);
			},
			extensions: [(pi) => pi.on("resources_discover", () => ({ skillPaths: [join(home, "dev-skills")] }))],
		});
		await host.trust();
		expect(await host.call("read_project_skill_file", { skill: DEV_SKILL })).toMatchObject(NOT_ALLOWED);
	});

	it("refuses a skill under $HOME that --skill adds", async () => {
		const host = await startHomeHost({
			args: ["--skill", "dev-skills"],
			prepare: (home) => writeSkill(join(home, "dev-skills"), DEV_SKILL),
		});
		await host.trust();
		expect(await host.call("read_project_skill_file", { skill: DEV_SKILL })).toMatchObject(NOT_ALLOWED);
	});
});

describe("project verbs: a loader without getUserSkillRoots (senpi#6558)", () => {
	it("still refuses the agent dir and ~/.agents/skills, without throwing", async () => {
		const host = await startHomeHost({
			prepare: (home) => {
				writeFileSync(join(home, AGENT_CONTEXT), "# Global rules\n");
				writeSkill(join(home, ".agents", "skills"), HOME_SKILL);
			},
		});
		await host.trust();
		const method = Object.getOwnPropertyDescriptor(DefaultResourceLoader.prototype, "getUserSkillRoots");
		Reflect.deleteProperty(DefaultResourceLoader.prototype, "getUserSkillRoots");
		try {
			expect(await host.call("read_project_file", { path: AGENT_CONTEXT })).toMatchObject(NOT_ALLOWED);
			expect(await host.call("read_project_skill_file", { skill: HOME_SKILL })).toMatchObject(NOT_ALLOWED);
		} finally {
			if (method !== undefined) Object.defineProperty(DefaultResourceLoader.prototype, "getUserSkillRoots", method);
		}
	});
});

describe("project verbs: a user-global root that does not exist yet (senpi#6558)", () => {
	it("refuses creating ~/.agents/skills/AGENTS.md when $HOME is a link", async () => {
		const host = await startHomeHost({ stubHome: "link" });
		await host.trust();
		expect(
			await host.call("write_project_file", { path: ".agents/skills/AGENTS.md", content: "# Pwned\n", ifEtag: null }),
		).toMatchObject(NOT_ALLOWED);
		expect(existsSync(join(host.cwd, ".agents", "skills", "AGENTS.md"))).toBe(false);
	});
});
