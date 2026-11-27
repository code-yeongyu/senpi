/**
 * senpi#6901 review L1/L2: every write_user_skill_file attempt from another device leaves exactly one audit line,
 * also one refused before any prompt (not listed, outside a root through a link or `..`, stale, too large), and an
 * audit line that cannot be written never turns a landed write into a reported failure.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { USER_SKILL_ALLOW } from "../../src/modes/rpc/user-skill-approval.ts";
import { type FolderLayout, skillSource, startFolderHost } from "./project-folder-verbs-host.ts";
import {
	auditLines,
	becomeRemote,
	disposeUserSkillHosts,
	EDITED,
	layUserSkill,
	ORIGIN,
	ORIGINAL,
	presentLocally,
	readData,
	USER_SKILL,
	type UserSkillData,
	userSkillFile,
	write,
} from "./user-skill-file-host.ts";

afterEach(disposeUserSkillHosts);

function layEscapes(layout: FolderLayout): void {
	layUserSkill(layout);
	mkdirSync(join(layout.outside, "linked"));
	writeFileSync(join(layout.outside, "linked", "SKILL.md"), skillSource("linked"));
	symlinkSync(join(layout.outside, "linked"), join(layout.agentDir, "skills", "linked"));
	mkdirSync(join(layout.outside, "dotdot"));
	writeFileSync(join(layout.outside, "dotdot", "SKILL.md"), skillSource("dotdot"));
}

describe("remote attempts refused before the prompt are audited", () => {
	it("audits a skill that is not listed, a link escape and a .. escape, reading nothing outside a root", async () => {
		const host = await startFolderHost({ settings: { skills: ["../outside/dotdot"] }, prepare: layEscapes });
		await becomeRemote(host);
		const cases = [
			["no-such-skill", "user_skill_not_listed"],
			["linked", "user_skill_file_not_allowed"],
			["dotdot", "user_skill_file_not_allowed"],
		] as const;
		for (const [skill, errorCode] of cases)
			expect(await write(host, skill, skillSource(skill, "Escaped."), null)).toMatchObject({ errorCode });
		expect(auditLines(host)).toEqual(
			cases.map(([, reason]) =>
				expect.objectContaining({
					originDeviceId: ORIGIN.deviceId,
					decision: "refused",
					reason,
					path: null,
					sha256Before: null,
					sha256After: null,
				}),
			),
		);
		expect(readFileSync(join(host.outside, "linked", "SKILL.md"), "utf8")).toBe(skillSource("linked"));
		expect(readFileSync(join(host.outside, "dotdot", "SKILL.md"), "utf8")).toBe(skillSource("dotdot"));
	});

	it("audits a stale etag and content over 512 KiB with the file's unchanged hash", async () => {
		const host = await startFolderHost({ prepare: layUserSkill });
		const first = await readData(host);
		await becomeRemote(host);
		expect(await write(host, USER_SKILL, EDITED, "sha256-stale")).toMatchObject({
			errorCode: "project_file_conflict",
		});
		expect(await write(host, USER_SKILL, "x".repeat(512 * 1024 + 1), first.etag)).toMatchObject({
			errorCode: "project_file_too_large",
		});
		const unchanged = first.etag?.replace("sha256-", "");
		expect(auditLines(host)).toEqual([
			expect.objectContaining({ decision: "refused", reason: "project_file_conflict", path: first.path }),
			expect.objectContaining({ decision: "refused", reason: "project_file_too_large", path: first.path }),
		]);
		for (const line of auditLines(host))
			expect([line.sha256Before, line.sha256After]).toEqual([unchanged, unchanged]);
		expect(readFileSync(userSkillFile(host), "utf8")).toBe(ORIGINAL);
	});
});

describe("an audit that cannot be written", () => {
	it("still reports an approved write that landed as written, with the audit error beside it", async () => {
		const host = await startFolderHost({
			prepare: (layout) => {
				layUserSkill(layout);
				writeFileSync(join(layout.agentDir, "audit"), "a file where the audit folder belongs");
			},
		});
		await presentLocally(host, USER_SKILL_ALLOW);
		const first = await readData(host);
		await becomeRemote(host);
		const written = await write(host, USER_SKILL, EDITED, first.etag);
		expect(written).toMatchObject({ success: true, data: { content: EDITED } });
		expect((written.data as UserSkillData & { auditError?: string }).auditError).toEqual(expect.any(String));
		expect(readFileSync(userSkillFile(host), "utf8")).toBe(EDITED);
	});
});
