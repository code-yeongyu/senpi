/**
 * The user-skill verb tests' fixture (omo-desktop-app#7981): a folder host whose agent dir holds one user skill, a
 * connection that can declare it speaks for another device, a local presenter standing in for an attached local
 * client, and the audit file's lines.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { ExtensionUIDialogOptions } from "../../src/core/extensions/types.ts";
import { attachMcpGrantPresentation } from "../../src/core/mcp-grant-presentations.ts";
import { USER_SKILL_AUDIT_FILE } from "../../src/modes/rpc/user-skill-approval.ts";
import { disposeFolderHosts, type FolderHost, type FolderLayout, skillSource } from "./project-folder-verbs-host.ts";

export const USER_SKILL = "usv-user-skill";
export const ORIGINAL = skillSource(USER_SKILL);
export const EDITED = skillSource(USER_SKILL, "Edited from a laptop.");
export const ORIGIN = { deviceId: "device-laptop", deviceName: "Laptop" };

export interface UserSkillData {
	skill: string;
	path: string;
	exists: boolean;
	content: string | null;
	etag: string | null;
}

export interface Prompt {
	title: string;
	choices: string[];
}

export const userSkillFile = ({ agentDir }: FolderLayout, name = USER_SKILL) =>
	join(agentDir, "skills", name, "SKILL.md");

export function layUserSkill(layout: FolderLayout): void {
	vi.stubEnv("HOME", join(layout.outside, "home"));
	mkdirSync(join(layout.agentDir, "skills", USER_SKILL), { recursive: true });
	writeFileSync(userSkillFile(layout), ORIGINAL);
}

export const read = (host: FolderHost, skill: string) => host.call("read_user_skill_file", { skill });
export const write = (host: FolderHost, skill: string, content: string, ifEtag: string | null) =>
	host.call("write_user_skill_file", { skill, content, ifEtag });

export async function readData(host: FolderHost, skill = USER_SKILL): Promise<UserSkillData> {
	const answer = await read(host, skill);
	expect(answer).toMatchObject({ success: true });
	return answer.data as UserSkillData;
}

/** The connection now speaks for another device, as a relay forwarder declares it; it may also offer grant_select. */
export async function becomeRemote(host: FolderHost, capabilities: readonly string[] = []): Promise<void> {
	const answer = await host.send({ type: "set_client_info", width: 80, capabilities, remoteOrigin: ORIGIN });
	expect(answer).toMatchObject({ success: true });
}

/** A local client attached on THIS device presents the question (what `security-presentations.ts` registers). */
export async function presentLocally(host: FolderHost, answer: string | undefined): Promise<Prompt[]> {
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

export function auditLines({ agentDir }: FolderLayout): Record<string, unknown>[] {
	const file = join(agentDir, USER_SKILL_AUDIT_FILE);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const detachers: Array<() => void> = [];

/** Registered by each test file that uses this fixture. */
export async function disposeUserSkillHosts(): Promise<void> {
	for (const detach of detachers.splice(0)) detach();
	await disposeFolderHosts();
}
