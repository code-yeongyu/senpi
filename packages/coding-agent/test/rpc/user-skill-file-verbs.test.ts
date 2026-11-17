/**
 * omo-desktop-app#7981: `read_user_skill_file` / `write_user_skill_file` edit a user-global skill by name, through the
 * one trust gate: this device's own write is pre-trusted, another device's write commits only once this device
 * approves it, the requester can never answer that question, and each remote write leaves one audit line.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIDialogOptions } from "../../src/core/extensions/types.ts";
import { attachMcpGrantPresentation } from "../../src/core/mcp-grant-presentations.ts";
import { classifyRpcMethod } from "../../src/modes/rpc/method-classes.ts";
import {
	USER_SKILL_ALLOW,
	USER_SKILL_AUDIT_FILE,
	USER_SKILL_DENY,
	userSkillPromptTitle,
} from "../../src/modes/rpc/user-skill-approval.ts";
import {
	disposeFolderHosts,
	type FolderHost,
	type FolderLayout,
	SKILL_NAME,
	skillSource,
	startFolderHost,
} from "./project-folder-verbs-host.ts";

const USER_SKILL = "usv-user-skill";
const ORIGINAL = skillSource(USER_SKILL);
const EDITED = skillSource(USER_SKILL, "Edited from a laptop.");
const ORIGIN = { deviceId: "device-laptop", deviceName: "Laptop" };

interface UserSkillData {
	skill: string;
	path: string;
	exists: boolean;
	content: string | null;
	etag: string | null;
}

interface Prompt {
	title: string;
	choices: string[];
}

const userSkillFile = ({ agentDir }: FolderLayout, name = USER_SKILL) => join(agentDir, "skills", name, "SKILL.md");

function layUserSkill(layout: FolderLayout): void {
	vi.stubEnv("HOME", join(layout.outside, "home"));
	mkdirSync(join(layout.agentDir, "skills", USER_SKILL), { recursive: true });
	writeFileSync(userSkillFile(layout), ORIGINAL);
}

const read = (host: FolderHost, skill: string) => host.call("read_user_skill_file", { skill });
const write = (host: FolderHost, skill: string, content: string, ifEtag: string | null) =>
	host.call("write_user_skill_file", { skill, content, ifEtag });

async function readData(host: FolderHost, skill = USER_SKILL): Promise<UserSkillData> {
	const answer = await read(host, skill);
	expect(answer).toMatchObject({ success: true });
	return answer.data as UserSkillData;
}

/** The connection now speaks for another device, as a relay forwarder declares it; it may also offer grant_select. */
async function becomeRemote(host: FolderHost, capabilities: readonly string[] = []): Promise<void> {
	const answer = await host.send({ type: "set_client_info", width: 80, capabilities, remoteOrigin: ORIGIN });
	expect(answer).toMatchObject({ success: true });
}

/** A local client attached on THIS device presents the question (what `security-presentations.ts` registers). */
async function presentLocally(host: FolderHost, answer: string | undefined): Promise<Prompt[]> {
	const state = await host.call("get_state");
	const durableId = (state.data as { sessionId: string }).sessionId;
	const prompts: Prompt[] = [];
	const detach = attachMcpGrantPresentation(
		durableId,
		async (title: string, choices: string[], _opts?: ExtensionUIDialogOptions) => {
			prompts.push({ title, choices });
			return answer;
		},
	);
	detachers.push(detach);
	return prompts;
}

function auditLines({ agentDir }: FolderLayout): Record<string, unknown>[] {
	const file = join(agentDir, USER_SKILL_AUDIT_FILE);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const detachers: Array<() => void> = [];

afterEach(async () => {
	for (const detach of detachers.splice(0)) detach();
	await disposeFolderHosts();
});

describe("user skill file verbs: classes", () => {
	it("classes both verbs as device_admin", () => {
		expect(classifyRpcMethod({ type: "read_user_skill_file", sessionId: "a", skill: "s" })).toBe("device_admin");
		expect(
			classifyRpcMethod({ type: "write_user_skill_file", sessionId: "a", skill: "s", content: "", ifEtag: null }),
		).toBe("device_admin");
	});
});

describe("write_user_skill_file from this device", () => {
	it("is pre-trusted: it commits with no prompt and no audit line", async () => {
		const host = await startFolderHost({ prepare: layUserSkill });
		const prompts = await presentLocally(host, USER_SKILL_ALLOW);
		const first = await readData(host);
		expect(first).toMatchObject({ skill: USER_SKILL, exists: true, content: ORIGINAL });
		const written = await write(host, USER_SKILL, EDITED, first.etag);
		expect(written).toMatchObject({ success: true, data: { content: EDITED } });
		expect(readFileSync(userSkillFile(host), "utf8")).toBe(EDITED);
		expect(prompts).toEqual([]);
		expect(auditLines(host)).toEqual([]);
	});

	it("refuses a stale etag with the current one", async () => {
		const host = await startFolderHost({ prepare: layUserSkill });
		const first = await readData(host);
		writeFileSync(userSkillFile(host), EDITED);
		const answer = await write(host, USER_SKILL, ORIGINAL, first.etag);
		expect(answer).toMatchObject({ success: false, errorCode: "project_file_conflict" });
		expect(readFileSync(userSkillFile(host), "utf8")).toBe(EDITED);
	});
});

describe("write_user_skill_file from another device", () => {
	it("writes nothing without approval on this device, even when the requester offers grant_select", async () => {
		const host = await startFolderHost({ prepare: layUserSkill });
		const first = await readData(host);
		await becomeRemote(host, ["grant_select"]);
		const answer = await write(host, USER_SKILL, EDITED, first.etag);
		expect(answer).toMatchObject({ success: false, errorCode: "user_skill_write_unconfirmed" });
		expect(readFileSync(userSkillFile(host), "utf8")).toBe(ORIGINAL);
		const [line] = auditLines(host);
		expect(line).toMatchObject({ originDeviceId: ORIGIN.deviceId, decision: "unconfirmed", path: first.path });
		expect(line?.sha256After).toBe(line?.sha256Before);
	});

	it("asks this device naming origin, path and diff, and commits once approved", async () => {
		const host = await startFolderHost({ prepare: layUserSkill });
		const prompts = await presentLocally(host, USER_SKILL_ALLOW);
		const first = await readData(host);
		await becomeRemote(host);
		const written = await write(host, USER_SKILL, EDITED, first.etag);
		expect(written).toMatchObject({ success: true, data: { content: EDITED } });
		expect(readFileSync(userSkillFile(host), "utf8")).toBe(EDITED);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.choices).toEqual([USER_SKILL_ALLOW, USER_SKILL_DENY]);
		expect(prompts[0]?.title).toContain(ORIGIN.deviceName);
		expect(prompts[0]?.title).toContain(first.path);
		expect(prompts[0]?.title).toContain("+Edited from a laptop.");
		expect(prompts[0]?.title).toContain("-Probe.");
		const [line] = auditLines(host);
		expect(line).toMatchObject({ originDeviceName: ORIGIN.deviceName, decision: "approved", path: first.path });
		expect(line?.sha256Before).toBe(first.etag?.replace("sha256-", ""));
		expect(line?.sha256After).toBe((written.data as UserSkillData).etag?.replace("sha256-", ""));
	});

	it("writes nothing when this device denies it", async () => {
		const host = await startFolderHost({ prepare: layUserSkill });
		await presentLocally(host, USER_SKILL_DENY);
		const first = await readData(host);
		await becomeRemote(host);
		expect(await write(host, USER_SKILL, EDITED, first.etag)).toMatchObject({
			success: false,
			errorCode: "user_skill_write_declined",
		});
		expect(readFileSync(userSkillFile(host), "utf8")).toBe(ORIGINAL);
		expect(auditLines(host)).toMatchObject([{ decision: "denied" }]);
	});

	it("shows the whole content of a new file", () => {
		const title = userSkillPromptTitle(ORIGIN, "/u/skills/x/SKILL.md", "", "line one\nline two\n");
		expect(title).toContain("+line one");
		expect(title).toContain("+line two");
	});
});

describe("user skill containment", () => {
	it("refuses a skill reached through a link that leaves the user skills folder", async () => {
		const host = await startFolderHost({
			prepare: (layout) => {
				layUserSkill(layout);
				mkdirSync(join(layout.outside, "linked"));
				writeFileSync(join(layout.outside, "linked", "SKILL.md"), skillSource("linked"));
				symlinkSync(join(layout.outside, "linked"), join(layout.agentDir, "skills", "linked"));
			},
		});
		expect(await read(host, "linked")).toMatchObject({ success: false, errorCode: "user_skill_file_not_allowed" });
		expect(await write(host, "linked", skillSource("linked", "Escaped."), null)).toMatchObject({
			success: false,
			errorCode: "user_skill_file_not_allowed",
		});
		expect(readFileSync(join(host.outside, "linked", "SKILL.md"), "utf8")).toBe(skillSource("linked"));
	});

	it("refuses a skill whose path climbs out of the user skills folder with ..", async () => {
		const host = await startFolderHost({
			settings: { skills: ["../outside/dotdot"] },
			prepare: (layout) => {
				layUserSkill(layout);
				mkdirSync(join(layout.outside, "dotdot"));
				writeFileSync(join(layout.outside, "dotdot", "SKILL.md"), skillSource("dotdot"));
			},
		});
		expect(await read(host, "dotdot")).toMatchObject({ success: false, errorCode: "user_skill_file_not_allowed" });
		expect(await write(host, "dotdot", skillSource("dotdot", "Escaped."), null)).toMatchObject({
			success: false,
			errorCode: "user_skill_file_not_allowed",
		});
		expect(readFileSync(join(host.outside, "dotdot", "SKILL.md"), "utf8")).toBe(skillSource("dotdot"));
	});

	it("refuses a listed skill outside every user skills folder (a project skill)", async () => {
		const host = await startFolderHost({ prepare: layUserSkill });
		await host.trust();
		expect(await read(host, SKILL_NAME)).toMatchObject({ success: false, errorCode: "user_skill_file_not_allowed" });
		expect(await read(host, "no-such-skill")).toMatchObject({ success: false, errorCode: "user_skill_not_listed" });
	});
});
