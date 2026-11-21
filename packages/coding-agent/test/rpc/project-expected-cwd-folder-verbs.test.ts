/**
 * The two folder writes senpi#6485 adds take the same `expectedCwd` as the other project writes (senpi#6659): stated
 * for another folder, the write is refused with `project_cwd_mismatch` and nothing is written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_CONFIG_DIR, SKILL_NAME, startFolderHost, disposeFolderHosts } from "./project-folder-verbs-host.ts";

afterEach(disposeFolderHosts);

describe("a folder write that states its folder", () => {
	it("refuses an MCP servers edit stated for another folder, and the file is not written", async () => {
		const host = await startFolderHost();
		await host.trust();
		const answer = await host.call("set_project_mcp_servers", {
			patch: { demo: { command: "echo" } },
			ifEtag: null,
			expectedCwd: host.outside,
		});
		expect(answer).toMatchObject({ success: false, errorCode: "project_cwd_mismatch" });
		expect(await host.call("get_project_mcp_servers")).toMatchObject({ success: true, data: { exists: false } });
	});

	it("refuses a skill file write stated for another folder, and the file keeps its bytes", async () => {
		const host = await startFolderHost();
		await host.trust();
		const path = join(host.cwd, PROJECT_CONFIG_DIR, "skills", SKILL_NAME, "SKILL.md");
		const before = readFileSync(path, "utf8");
		const answer = await host.call("write_project_skill_file", {
			skill: SKILL_NAME,
			content: "edited",
			ifEtag: null,
			expectedCwd: host.outside,
		});
		expect(answer).toMatchObject({ success: false, errorCode: "project_cwd_mismatch" });
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("writes the MCP servers file when the stated folder is the session's", async () => {
		const host = await startFolderHost();
		await host.trust();
		const answer = await host.call("set_project_mcp_servers", {
			patch: { demo: { command: "echo" } },
			ifEtag: null,
			expectedCwd: `${host.cwd}/`,
		});
		expect(answer).toMatchObject({ success: true, data: { exists: true } });
	});

	it("writes the skill file when the stated folder is the session's", async () => {
		const host = await startFolderHost();
		await host.trust();
		const read = await host.call("read_project_skill_file", { skill: SKILL_NAME });
		const etag = (read.data as { etag: string | null }).etag;
		const answer = await host.call("write_project_skill_file", {
			skill: SKILL_NAME,
			content: "edited",
			ifEtag: etag,
			expectedCwd: `${host.cwd}/`,
		});
		expect(answer).toMatchObject({ success: true, data: { exists: true } });
		expect(readFileSync(join(host.cwd, PROJECT_CONFIG_DIR, "skills", SKILL_NAME, "SKILL.md"), "utf8")).toBe("edited");
	});
});
