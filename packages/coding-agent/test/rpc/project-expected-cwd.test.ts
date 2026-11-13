/**
 * A project write may state the folder its caller means (`expectedCwd`). A remote client that reaches a session by a
 * key that can since name another session states it, so a write never lands in another folder's project: when the
 * session's working directory is another folder, the write is refused with `project_cwd_mismatch` and nothing is
 * written. Without it, a write goes as before.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHost } from "./projectHost.ts";

describe("a project write that states its folder", () => {
	it("is refused for a session in another folder, and the file is not written", async () => {
		const host = await startHost();
		await host.trust();
		const answer = await host.send({
			type: "write_project_file",
			sessionId: host.sessionId,
			path: "AGENTS.md",
			content: "rules",
			ifEtag: null,
			expectedCwd: host.outside,
		});
		expect(answer).toMatchObject({ success: false, errorCode: "project_cwd_mismatch" });
		expect(existsSync(join(host.cwd, "AGENTS.md"))).toBe(false);
	});

	it("refuses a trust change and a setting stated for another folder, and changes neither", async () => {
		const host = await startHost();
		const trust = await host.send({
			type: "set_project_trust",
			sessionId: host.sessionId,
			choice: "trust",
			expectedCwd: host.outside,
		});
		expect(trust).toMatchObject({ success: false, errorCode: "project_cwd_mismatch" });
		const stillUntrusted = await host.write("AGENTS.md", "x", null);
		expect(stillUntrusted).toMatchObject({ success: false, errorCode: "project_not_trusted" });

		await host.trust();
		const setting = await host.send({
			type: "set_project_setting",
			sessionId: host.sessionId,
			key: "defaultThinkingLevel",
			value: "minimal",
			expectedCwd: host.outside,
		});
		expect(setting).toMatchObject({ success: false, errorCode: "project_cwd_mismatch" });
		const settings = await host.send({ type: "get_project_settings", sessionId: host.sessionId });
		expect(JSON.stringify(settings.data)).not.toContain("minimal");
	});

	it("is written when the stated folder is the session's, a trailing separator included", async () => {
		const host = await startHost();
		await host.trust();
		const answer = await host.send({
			type: "write_project_file",
			sessionId: host.sessionId,
			path: "AGENTS.md",
			content: "rules",
			ifEtag: null,
			expectedCwd: `${host.cwd}/`,
		});
		expect(answer).toMatchObject({ success: true, command: "write_project_file" });
		expect(readFileSync(join(host.cwd, "AGENTS.md"), "utf8")).toBe("rules");
	});

	it("is written as before when it states no folder", async () => {
		const host = await startHost();
		await host.trust();
		const answer = await host.write("AGENTS.md", "rules", null);
		expect(answer).toMatchObject({ success: true, command: "write_project_file" });
	});

	it("is refused when the session's folder differs only by surrounding whitespace or a POSIX backslash", async () => {
		const host = await startHost();
		await host.trust();
		for (const stated of [`${host.cwd} `, `${host.cwd}\\`]) {
			const answer = await host.send({
				type: "write_project_file",
				sessionId: host.sessionId,
				path: "AGENTS.md",
				content: "rules",
				ifEtag: null,
				expectedCwd: stated,
			});
			expect(answer).toMatchObject({ success: false, errorCode: "project_cwd_mismatch" });
		}
		expect(existsSync(join(host.cwd, "AGENTS.md"))).toBe(false);
	});
});
