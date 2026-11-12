/**
 * senpi#6547 review LOWs: the project verbs reach only the session folder's own files, never user-global
 * configuration. A session whose folder is the PARENT of a user-global root (a session opened in `$HOME`, whose
 * folder holds the agent dir and `~/.agents`) is refused on every project verb when the file it names is
 * user-global, compared by real path: the agent dir (its context file, its skills, the global MCP file) and every
 * user-global skill root the engine loads — the one list that also builds the loader's skill allowlist. The
 * folder's own project files keep working in the same session, and a link from inside the folder into a global
 * root is refused by real path too.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	disposeFolderHosts,
	type FolderHost,
	type FolderLayout,
	PROJECT_CONFIG_DIR,
	SKILL_NAME,
	skillSource,
	startFolderHost,
	type WireRecord,
} from "./project-folder-verbs-host.ts";

const AGENT_CONTEXT = `${PROJECT_CONFIG_DIR}/agent/AGENTS.md`;
const AGENTS_SKILL_FILE = ".agents/skills/ugr-home-skill/AGENTS.md";
const HOME_SKILL = "ugr-home-skill";
const SELECTED_SKILL = "ugr-sel-skill";
const SERVER = { command: "node", args: ["server.js"] };
const STORED_MCP = '{"mcpServers":{}}';

const etagOf = (content: string): string => `sha256-${createHash("sha256").update(content).digest("hex")}`;

/**
 * A session opened in `$HOME`: the scratch folder is both the cwd and (stubbed) `HOME`, so the session folder is
 * the parent of the agent dir and of `~/.agents`. `prepare` lays out files under that home before the session
 * opens; `settings` may depend on the layout (a selected skill root is an absolute path in it).
 */
async function startHomeHost(
	options: {
		readonly settings?: WireRecord | ((layout: FolderLayout) => WireRecord);
		readonly prepare?: (home: string) => void;
	} = {},
): Promise<FolderHost> {
	return startFolderHost({
		layout: (scratch) => ({ cwd: scratch, agentDir: join(scratch, PROJECT_CONFIG_DIR, "agent") }),
		stubHome: true,
		prepare: (layout) => options.prepare?.(layout.cwd),
		settings: options.settings,
	});
}

afterEach(disposeFolderHosts);

describe("project verbs: user-global files are refused by real path", () => {
	it("refuses the agent dir's context file for read_project_file and write_project_file", async () => {
		const host = await startHomeHost({
			prepare: (home) => writeFileSync(join(home, AGENT_CONTEXT), "# Global rules\n"),
		});
		await host.trust();
		expect(await host.call("read_project_file", { path: AGENT_CONTEXT })).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(
			await host.call("write_project_file", {
				path: AGENT_CONTEXT,
				content: "# Pwned\n",
				ifEtag: etagOf("# Global rules\n"),
			}),
		).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(readFileSync(join(host.cwd, AGENT_CONTEXT), "utf8")).toBe("# Global rules\n");
	});

	it("refuses an instruction file inside ~/.agents for read_project_file and write_project_file", async () => {
		const host = await startHomeHost({
			prepare: (home) => {
				mkdirSync(join(home, ".agents", "skills", HOME_SKILL), { recursive: true });
				writeFileSync(join(home, AGENTS_SKILL_FILE), "# Inside a user skill root\n");
			},
		});
		await host.trust();
		expect(await host.call("read_project_file", { path: AGENTS_SKILL_FILE })).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(
			await host.call("write_project_file", {
				path: AGENTS_SKILL_FILE,
				content: "# Pwned\n",
				ifEtag: etagOf("# Inside a user skill root\n"),
			}),
		).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(readFileSync(join(host.cwd, AGENTS_SKILL_FILE), "utf8")).toBe("# Inside a user skill root\n");
	});

	it("refuses a ~/.agents/skills skill for read_project_skill_file and write_project_skill_file", async () => {
		const host = await startHomeHost({
			prepare: (home) => {
				mkdirSync(join(home, ".agents", "skills", HOME_SKILL), { recursive: true });
				writeFileSync(join(home, ".agents", "skills", HOME_SKILL, "SKILL.md"), skillSource(HOME_SKILL));
			},
		});
		await host.trust();
		expect(await host.call("read_project_skill_file", { skill: HOME_SKILL })).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(
			await host.call("write_project_skill_file", {
				skill: HOME_SKILL,
				content: skillSource(HOME_SKILL, "Pwned."),
				ifEtag: etagOf(skillSource(HOME_SKILL)),
			}),
		).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(readFileSync(join(host.cwd, ".agents", "skills", HOME_SKILL, "SKILL.md"), "utf8")).toBe(
			skillSource(HOME_SKILL),
		);
	});

	it("refuses a skill from a user-selected skill root for read_project_skill_file and write_project_skill_file", async () => {
		const host = await startHomeHost({
			settings: ({ cwd }) => ({ skills: [join(cwd, "selected-skill-root")] }),
			prepare: (home) => {
				mkdirSync(join(home, "selected-skill-root", SELECTED_SKILL), { recursive: true });
				writeFileSync(join(home, "selected-skill-root", SELECTED_SKILL, "SKILL.md"), skillSource(SELECTED_SKILL));
			},
		});
		await host.trust();
		expect(await host.call("read_project_skill_file", { skill: SELECTED_SKILL })).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(
			await host.call("write_project_skill_file", {
				skill: SELECTED_SKILL,
				content: skillSource(SELECTED_SKILL, "Pwned."),
				ifEtag: etagOf(skillSource(SELECTED_SKILL)),
			}),
		).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(readFileSync(join(host.cwd, "selected-skill-root", SELECTED_SKILL, "SKILL.md"), "utf8")).toBe(
			skillSource(SELECTED_SKILL),
		);
	});

	it("refuses the project MCP file when it lies in a user-selected skill root, for get and set", async () => {
		const host = await startHomeHost({
			settings: ({ cwd }) => ({ skills: [join(cwd, PROJECT_CONFIG_DIR)] }),
			prepare: (home) => writeFileSync(join(home, PROJECT_CONFIG_DIR, "mcp.json"), STORED_MCP),
		});
		await host.trust();
		expect(await host.call("get_project_mcp_servers")).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(
			await host.call("set_project_mcp_servers", { patch: { alpha: SERVER }, ifEtag: etagOf(STORED_MCP) }),
		).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(readFileSync(join(host.cwd, PROJECT_CONFIG_DIR, "mcp.json"), "utf8")).toBe(STORED_MCP);
	});

	it("refuses a skill reached through a link from the project into ~/.agents, for read and write", async () => {
		const host = await startHomeHost({
			prepare: (home) => {
				mkdirSync(join(home, ".agents", "skills", HOME_SKILL), { recursive: true });
				writeFileSync(join(home, ".agents", "skills", HOME_SKILL, "SKILL.md"), skillSource(HOME_SKILL));
				symlinkSync(
					join(home, ".agents", "skills", HOME_SKILL),
					join(home, PROJECT_CONFIG_DIR, "skills", "linked-global"),
				);
			},
		});
		await host.trust();
		expect(await host.call("read_project_skill_file", { skill: HOME_SKILL })).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(
			await host.call("write_project_skill_file", {
				skill: HOME_SKILL,
				content: skillSource(HOME_SKILL, "Pwned."),
				ifEtag: etagOf(skillSource(HOME_SKILL)),
			}),
		).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(readFileSync(join(host.cwd, ".agents", "skills", HOME_SKILL, "SKILL.md"), "utf8")).toBe(
			skillSource(HOME_SKILL),
		);
	});
});

describe("project verbs: the folder's own files still work in a session opened in $HOME", () => {
	it("reads and writes the project's instruction file, skill and MCP file in the same session", async () => {
		const host = await startHomeHost();
		await host.trust();
		const missing = await host.call("read_project_file", { path: "AGENTS.md" });
		expect(missing).toMatchObject({ success: true, data: { exists: false } });
		expect(
			await host.call("write_project_file", { path: "AGENTS.md", content: "# Rules\n", ifEtag: null }),
		).toMatchObject({ success: true });

		const skill = await host.call("read_project_skill_file", { skill: SKILL_NAME });
		expect(skill).toMatchObject({ success: true, data: { skill: SKILL_NAME, exists: true } });
		expect(
			await host.call("write_project_skill_file", {
				skill: SKILL_NAME,
				content: skillSource(SKILL_NAME, "Edited."),
				ifEtag: (skill.data as { etag: string }).etag,
			}),
		).toMatchObject({ success: true });

		expect(await host.call("set_project_mcp_servers", { patch: { alpha: SERVER }, ifEtag: null })).toMatchObject({
			success: true,
		});
		expect(await host.call("get_project_mcp_servers")).toMatchObject({
			success: true,
			data: { exists: true, mcpServers: { alpha: SERVER }, parseError: null },
		});
	});
});
