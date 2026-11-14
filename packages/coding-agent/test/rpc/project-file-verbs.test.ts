/**
 * An RPC client reads and edits the session workspace's instruction files (AGENTS.md, CLAUDE.md, nested AGENTS.md,
 * `.omo/rules/**`) with `read_project_file` / `write_project_file`, the verbs a remote desktop needs to edit Rules on a
 * machine it has no filesystem access to. Records go through the multi-session host's own dispatch on
 * the in-process registry with a faux provider; the project carries a project skill, so trust gates it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyRpcMethod } from "../../src/modes/rpc/method-classes.ts";
import { startHost } from "./projectHost.ts";

interface FileData {
	path: string;
	exists: boolean;
	content: string | null;
	etag: string | null;
	projectTrusted: boolean;
}

describe("project file verbs: classes and wire shape", () => {
	it("classes both verbs as device_admin", () => {
		expect(classifyRpcMethod({ type: "read_project_file", sessionId: "a", path: "AGENTS.md" })).toBe("device_admin");
		expect(
			classifyRpcMethod({
				type: "write_project_file",
				sessionId: "a",
				path: "AGENTS.md",
				content: "",
				ifEtag: null,
			}),
		).toBe("device_admin");
	});
});

describe("read_project_file", () => {
	it("answers a missing allowlisted file as success with exists:false", async () => {
		const host = await startHost();
		const answer = await host.read("AGENTS.md");
		expect(answer).toMatchObject({ success: true, command: "read_project_file" });
		expect(answer.data).toMatchObject({ path: "AGENTS.md", exists: false, content: null, etag: null });
	});

	it("reads an existing file while the project is untrusted, with an etag", async () => {
		const host = await startHost();
		writeFileSync(join(host.cwd, "AGENTS.md"), "# Rules\n");
		const data = (await host.read("AGENTS.md")).data as FileData;
		expect(data).toMatchObject({ exists: true, content: "# Rules\n", projectTrusted: false });
		expect(typeof data.etag).toBe("string");
	});
});

describe("write_project_file", () => {
	it("refuses a write while the project is untrusted and creates nothing", async () => {
		const host = await startHost();
		const answer = await host.write("AGENTS.md", "x", null);
		expect(answer).toMatchObject({ success: false, errorCode: "project_not_trusted" });
		expect(existsSync(join(host.cwd, "AGENTS.md"))).toBe(false);
	});

	it("creates, updates and reads back once trusted, refusing a stale or missing etag", async () => {
		const host = await startHost();
		await host.trust();
		const created = await host.write("AGENTS.md", "one\n", null);
		expect(created).toMatchObject({ success: true, command: "write_project_file" });
		const first = created.data as FileData;
		expect(first).toMatchObject({ exists: true, content: "one\n" });
		expect(readFileSync(join(host.cwd, "AGENTS.md"), "utf8")).toBe("one\n");

		const updated = (await host.write("AGENTS.md", "two\n", first.etag)).data as FileData;
		expect(updated.content).toBe("two\n");
		expect(updated.etag).not.toBe(first.etag);

		const stale = await host.write("AGENTS.md", "three\n", first.etag);
		expect(stale).toMatchObject({
			success: false,
			errorCode: "project_file_conflict",
			errorData: { currentEtag: updated.etag, exists: true },
		});
		const createOverExisting = await host.write("AGENTS.md", "three\n", null);
		expect(createOverExisting).toMatchObject({ success: false, errorCode: "project_file_conflict" });
		expect(readFileSync(join(host.cwd, "AGENTS.md"), "utf8")).toBe("two\n");

		const noEtag = await host.send({
			type: "write_project_file",
			sessionId: host.sessionId,
			path: "AGENTS.md",
			content: "x",
		});
		expect(noEtag).toMatchObject({ success: false, errorCode: "invalid_argument" });
	});

	it("reports a conflict on an etag for a file that was deleted meanwhile", async () => {
		const host = await startHost();
		await host.trust();
		const first = (await host.write("CLAUDE.md", "a", null)).data as FileData;
		rmSync(join(host.cwd, "CLAUDE.md"));
		const answer = await host.write("CLAUDE.md", "b", first.etag);
		expect(answer).toMatchObject({
			success: false,
			errorCode: "project_file_conflict",
			errorData: { currentEtag: null, exists: false },
		});
	});

	it("creates a nested AGENTS.md and a rule file under .omo/rules, making the folders", async () => {
		const host = await startHost();
		await host.trust();
		for (const path of ["packages/app/AGENTS.md", ".omo/rules/style/naming.md"]) {
			expect(await host.write(path, `# ${path}\n`, null)).toMatchObject({ success: true });
			expect(readFileSync(join(host.cwd, path), "utf8")).toBe(`# ${path}\n`);
		}
	});

	it("refuses content over 512 KiB", async () => {
		const host = await startHost();
		await host.trust();
		const answer = await host.write("AGENTS.md", "x".repeat(512 * 1024 + 1), null);
		expect(answer).toMatchObject({ success: false, errorCode: "project_file_too_large" });
		expect(existsSync(join(host.cwd, "AGENTS.md"))).toBe(false);
	});
});

describe("project file verbs: stored file limits and permissions", () => {
	it("refuses to read a stored file over 512 KiB without returning it", async () => {
		const host = await startHost();
		writeFileSync(join(host.cwd, "AGENTS.md"), "x".repeat(512 * 1024 + 1));
		expect(await host.read("AGENTS.md")).toMatchObject({
			success: false,
			errorCode: "project_file_too_large",
			errorData: { limitBytes: 512 * 1024 },
		});
	});

	it("keeps an existing file's permissions when replacing it", async () => {
		const host = await startHost();
		await host.trust();
		const first = (await host.write("AGENTS.md", "one\n", null)).data as FileData;
		chmodSync(join(host.cwd, "AGENTS.md"), 0o600);
		expect(await host.write("AGENTS.md", "two\n", first.etag)).toMatchObject({ success: true });
		expect(statSync(join(host.cwd, "AGENTS.md")).mode & 0o777).toBe(0o600);
	});
});

describe("project file verbs: only allowlisted paths inside the workspace", () => {
	const refused = [
		"../outside/AGENTS.md",
		"/etc/AGENTS.md",
		"packages/../../outside/AGENTS.md",
		"./AGENTS.md",
		"a//AGENTS.md",
		"a\\AGENTS.md",
		"",
		"src/index.ts",
		"README.md",
		".omo/mcp.json",
		".omo/rules",
		".git/AGENTS.md",
		"node_modules/x/AGENTS.md",
		"AGENTS.md\u0000.ts",
		".omo/rules/a\\b.md",
		".omo/rules/x\u0000.md",
		".omo/rules/a:b.md",
	];

	it.each(refused)("refuses %j for read and write", async (path) => {
		const host = await startHost();
		await host.trust();
		expect(await host.read(path)).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(await host.write(path, "x", null)).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
	});

	it("refuses a non-string path as invalid_argument", async () => {
		const host = await startHost();
		expect(await host.read(42)).toMatchObject({ success: false, errorCode: "invalid_argument" });
	});

	it("refuses a symlinked file and a symlinked folder that lead outside, and leaves the target alone", async () => {
		const host = await startHost();
		await host.trust();
		writeFileSync(join(host.outside, "AGENTS.md"), "outside\n");
		symlinkSync(join(host.outside, "AGENTS.md"), join(host.cwd, "AGENTS.md"));
		symlinkSync(host.outside, join(host.cwd, "linked"));
		for (const path of ["AGENTS.md", "linked/AGENTS.md"]) {
			expect(await host.read(path)).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
			expect(await host.write(path, "pwned\n", null)).toMatchObject({
				success: false,
				errorCode: "project_file_not_allowed",
			});
		}
		expect(await host.write("linked/new/AGENTS.md", "pwned\n", null)).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(readFileSync(join(host.outside, "AGENTS.md"), "utf8")).toBe("outside\n");
		expect(existsSync(join(host.outside, "new"))).toBe(false);
	});

	it("refuses a folder where the file should be", async () => {
		const host = await startHost();
		await host.trust();
		mkdirSync(join(host.cwd, "AGENTS.md"));
		expect(await host.read("AGENTS.md")).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
	});
});
