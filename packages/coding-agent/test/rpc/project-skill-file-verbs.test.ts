/**
 * senpi#6485: `read_project_skill_file` / `write_project_skill_file` read and edit the file of a skill the engine lists
 * for the session folder, contained to that folder, so a remote client edits skills the way a local one does.
 * One test per gate and per refusal; every accepted write answers the read-back `read_project_skill_file` gives.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import { classifyRpcMethod } from "../../src/modes/rpc/method-classes.ts";
import {
	disposeFolderHosts,
	type FolderHost,
	type FolderLayout,
	PROJECT_CONFIG_DIR,
	SKILL_NAME,
	skillSource,
	startFolderHost,
} from "./project-folder-verbs-host.ts";

interface SkillFileData {
	skill: string;
	path: string;
	exists: boolean;
	content: string | null;
	etag: string | null;
	projectTrusted: boolean;
}

const SKILL_PATH = `${PROJECT_CONFIG_DIR}/skills/${SKILL_NAME}/SKILL.md`;
const ORIGINAL = skillSource(SKILL_NAME);
const EDITED = skillSource(SKILL_NAME, "Edited.");

const read = (host: FolderHost, skill: unknown) => host.call("read_project_skill_file", { skill });
const write = (host: FolderHost, skill: unknown, content: unknown, ifEtag: unknown) =>
	host.call("write_project_skill_file", { skill, content, ifEtag });
const onDisk = (host: FolderHost) => readFileSync(join(host.cwd, SKILL_PATH), "utf8");

async function trustedRead(host: FolderHost): Promise<SkillFileData> {
	await host.trust();
	const answer = await read(host, SKILL_NAME);
	expect(answer).toMatchObject({ success: true });
	return answer.data as SkillFileData;
}

function projectSkillDir({ cwd }: FolderLayout, name: string): string {
	return join(cwd, PROJECT_CONFIG_DIR, "skills", name);
}

afterEach(disposeFolderHosts);

describe("project skill file verbs: classes and session", () => {
	it("classes both verbs as device_admin", () => {
		expect(classifyRpcMethod({ type: "read_project_skill_file", sessionId: "a", skill: "s" })).toBe("device_admin");
		expect(
			classifyRpcMethod({ type: "write_project_skill_file", sessionId: "a", skill: "s", content: "", ifEtag: null }),
		).toBe("device_admin");
	});

	it("refuses both verbs for a session the host does not have", async () => {
		const host = await startFolderHost();
		for (const command of [
			{ type: "read_project_skill_file", skill: SKILL_NAME },
			{ type: "write_project_skill_file", skill: SKILL_NAME, content: EDITED, ifEtag: null },
		]) {
			expect(await host.send({ ...command, sessionId: "no-such-session" })).toMatchObject({
				success: false,
				error: "unknown_session",
			});
		}
		expect(onDisk(host)).toBe(ORIGINAL);
	});
});

describe("write_project_skill_file: accepted writes", () => {
	it("reads a listed skill's file and replaces it, answering the read-back", async () => {
		const host = await startFolderHost();
		const first = await trustedRead(host);
		expect(first).toMatchObject({ skill: SKILL_NAME, path: SKILL_PATH, exists: true, content: ORIGINAL });
		expect(first.etag).toEqual(expect.any(String));
		const written = await write(host, SKILL_NAME, EDITED, first.etag);
		expect(written).toMatchObject({ success: true, command: "write_project_skill_file", data: { content: EDITED } });
		expect((written.data as SkillFileData).etag).not.toBe(first.etag);
		expect(onDisk(host)).toBe(EDITED);
		expect((await read(host, SKILL_NAME)).data).toEqual(written.data);
	});
});

describe("write_project_skill_file: refusals", () => {
	it("refuses a write while the folder is untrusted", async () => {
		const host = await startFolderHost();
		expect(await write(host, SKILL_NAME, EDITED, null)).toMatchObject({
			success: false,
			errorCode: "project_not_trusted",
		});
		expect(onDisk(host)).toBe(ORIGINAL);
	});

	it("checks trust on every write: trust withdrawn over RPC refuses the next write", async () => {
		const host = await startFolderHost();
		const first = await trustedRead(host);
		await host.call("set_project_trust", { choice: "do_not_trust" });
		expect(await write(host, SKILL_NAME, EDITED, first.etag)).toMatchObject({
			success: false,
			errorCode: "project_not_trusted",
		});
		expect(onDisk(host)).toBe(ORIGINAL);
	});

	it("checks trust on every write: a 'do not trust' saved by another session refuses the next write", async () => {
		const host = await startFolderHost();
		const first = await trustedRead(host);
		new ProjectTrustStore(host.agentDir).set(host.cwd, false);
		expect(await write(host, SKILL_NAME, EDITED, first.etag)).toMatchObject({
			success: false,
			errorCode: "project_not_trusted",
		});
		expect(onDisk(host)).toBe(ORIGINAL);
	});

	it("refuses a stale etag with the current one", async () => {
		const host = await startFolderHost();
		const first = await trustedRead(host);
		writeFileSync(join(host.cwd, SKILL_PATH), EDITED);
		const answer = await write(host, SKILL_NAME, ORIGINAL, first.etag);
		expect(answer).toMatchObject({ success: false, errorCode: "project_file_conflict" });
		expect((answer.errorData as { currentEtag: unknown }).currentEtag).not.toBe(first.etag);
		expect(onDisk(host)).toBe(EDITED);
	});

	it("refuses a skill the engine does not list, for read and write", async () => {
		const host = await startFolderHost({
			prepare: (layout) => mkdirSync(projectSkillDir(layout, "not-a-skill"), { recursive: true }),
		});
		await host.trust();
		for (const skill of ["no-such-skill", "not-a-skill"]) {
			expect(await read(host, skill)).toMatchObject({ success: false, errorCode: "project_skill_not_listed" });
			expect(await write(host, skill, EDITED, null)).toMatchObject({
				success: false,
				errorCode: "project_skill_not_listed",
			});
		}
		expect(existsSync(join(projectSkillDir(host, "not-a-skill"), "SKILL.md"))).toBe(false);
	});

	it("refuses content over 512 KiB", async () => {
		const host = await startFolderHost();
		const first = await trustedRead(host);
		expect(await write(host, SKILL_NAME, "x".repeat(512 * 1024 + 1), first.etag)).toMatchObject({
			success: false,
			errorCode: "project_file_too_large",
		});
		expect(onDisk(host)).toBe(ORIGINAL);
	});

	it("routes the write through the machine's own edit permission: a deny refuses it", async () => {
		const host = await startFolderHost({ settings: { permission: { edit: { "**/SKILL.md": "deny" } } } });
		const first = await trustedRead(host);
		expect(await write(host, SKILL_NAME, EDITED, first.etag)).toMatchObject({
			success: false,
			errorCode: "project_file_permission_denied",
		});
		expect(onDisk(host)).toBe(ORIGINAL);
	});
});

describe("project skill file verbs: containment", () => {
	it("refuses a listed skill whose file lies outside the folder (a global skill)", async () => {
		const host = await startFolderHost({
			prepare: ({ agentDir }) => {
				mkdirSync(join(agentDir, "skills", "global-skill"), { recursive: true });
				writeFileSync(join(agentDir, "skills", "global-skill", "SKILL.md"), skillSource("global-skill"));
			},
		});
		await host.trust();
		expect(await read(host, "global-skill")).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(await write(host, "global-skill", EDITED, null)).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(readFileSync(join(host.agentDir, "skills", "global-skill", "SKILL.md"), "utf8")).toBe(
			skillSource("global-skill"),
		);
	});

	it("writes a hard-linked skill file by replacing the link, leaving the other name's bytes alone (senpi#6532 review L1)", async () => {
		const host = await startFolderHost({
			prepare: (layout) => {
				const target = join(projectSkillDir(layout, SKILL_NAME), "SKILL.md");
				const elsewhere = join(layout.outside, "SKILL.md");
				renameSync(target, elsewhere);
				linkSync(elsewhere, target);
			},
		});
		const before = await trustedRead(host);
		expect(await write(host, SKILL_NAME, EDITED, before.etag)).toMatchObject({ success: true });
		expect(onDisk(host)).toBe(EDITED);
		expect(readFileSync(join(host.outside, "SKILL.md"), "utf8")).toBe(ORIGINAL);
	});

	it("refuses a global skill even when the agent dir lies inside the session folder (senpi#6532 review L2)", async () => {
		const host = await startFolderHost({
			agentDirInsideFolder: true,
			prepare: ({ agentDir }) => {
				mkdirSync(join(agentDir, "skills", "global-skill"), { recursive: true });
				writeFileSync(join(agentDir, "skills", "global-skill", "SKILL.md"), skillSource("global-skill"));
			},
		});
		await host.trust();
		expect(await read(host, "global-skill")).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(await write(host, "global-skill", EDITED, null)).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(readFileSync(join(host.agentDir, "skills", "global-skill", "SKILL.md"), "utf8")).toBe(
			skillSource("global-skill"),
		);
	});

	it.each([
		[
			"its folder swapped for a link that leaves the folder",
			(layout: FolderLayout) => {
				renameSync(projectSkillDir(layout, SKILL_NAME), join(layout.outside, "moved"));
				symlinkSync(join(layout.outside, "moved"), projectSkillDir(layout, SKILL_NAME));
			},
		],
		[
			"its file swapped for a link that leaves the folder",
			(layout: FolderLayout) => {
				mkdirSync(join(layout.outside, "moved"));
				renameSync(join(layout.cwd, SKILL_PATH), join(layout.outside, "moved", "SKILL.md"));
				symlinkSync(join(layout.outside, "moved", "SKILL.md"), join(layout.cwd, SKILL_PATH));
			},
		],
	])("refuses a listed skill with %s, and leaves the target alone", async (_label, swap) => {
		const host = await startFolderHost();
		const first = await trustedRead(host);
		swap(host);
		expect(await read(host, SKILL_NAME)).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(await write(host, SKILL_NAME, EDITED, first.etag)).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(readFileSync(join(host.outside, "moved", "SKILL.md"), "utf8")).toBe(ORIGINAL);
	});
});
