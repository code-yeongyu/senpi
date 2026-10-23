import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kernelPathEntry } from "../src/extension/kernel-path-env.ts";

// Bare-name lookup as libuv (Bun/Node spawn) and `where` do it on Windows: `;` PATH, first directory wins, PATHEXT `.exe`.
function windowsWhich(name: string, path: string): string | undefined {
	for (const dir of path.split(";").filter(Boolean)) {
		const candidate = join(dir, `${name}.exe`);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function fakeExe(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}.exe`);
	writeFileSync(file, "");
	return file;
}

const unchangedEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => env;

describe("kernelPathEntry (omo#10894)", () => {
	let root: string;
	let system32: string;
	let gitCmd: string;
	let gitBin: string;
	let gitBash: string;
	let inheritedPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kernel-path-env-"));
		system32 = join(root, "Windows", "System32");
		gitCmd = join(root, "Git", "cmd");
		gitBin = join(root, "Git", "bin");
		fakeExe(system32, "bash");
		fakeExe(gitCmd, "git");
		gitBash = fakeExe(gitBin, "bash");
		fakeExe(gitBin, "sh");
		inheritedPath = [system32, gitCmd].join(";");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("puts the Git Bash directory first on win32 so a bare bash resolves to Git Bash, not the WSL launcher", () => {
		expect(windowsWhich("bash", inheritedPath)).toBe(join(system32, "bash.exe"));

		const entry = kernelPathEntry({
			platform: "win32",
			env: { Path: inheritedPath },
			resolveBash: () => gitBash,
			withBundledBun: unchangedEnv,
		});

		expect(entry.Path?.split(";")[0]).toBe(gitBin);
		expect(windowsWhich("bash", entry.Path ?? "")).toBe(gitBash);
		expect(windowsWhich("sh", entry.Path ?? "")).toBe(join(gitBin, "sh.exe"));
		expect(entry.Path?.split(";").slice(1)).toEqual([system32, gitCmd]);
	});

	it("keeps the Git Bash directory once when PATH already lists it later", () => {
		const entry = kernelPathEntry({
			platform: "win32",
			env: { PATH: [system32, gitBin.toUpperCase(), gitCmd].join(";") },
			resolveBash: () => gitBash,
			withBundledBun: unchangedEnv,
		});

		expect(entry.PATH?.split(";")).toEqual([gitBin, system32, gitCmd]);
	});

	it("leaves PATH unchanged on win32 when no Git Bash is found", () => {
		const entry = kernelPathEntry({
			platform: "win32",
			env: { Path: inheritedPath },
			resolveBash: () => undefined,
			withBundledBun: unchangedEnv,
		});

		expect(entry).toEqual({});
	});

	it("never prepends the WSL launcher the bash tool falls back to from PATH", () => {
		const entry = kernelPathEntry({
			platform: "win32",
			env: { Path: inheritedPath },
			resolveBash: () => "C:\\Windows\\System32\\bash.exe",
			withBundledBun: unchangedEnv,
		});

		expect(entry).toEqual({});
	});

	it("puts the configured shellPath's Git bin first, over the default Git install, through getShellConfig", () => {
		const portableBin = join(root, "PortableGit", "bin");
		const portableBash = fakeExe(portableBin, "bash");
		fakeExe(portableBin, "sh");

		const entry = kernelPathEntry({
			platform: "win32",
			env: { Path: inheritedPath },
			shellPath: portableBash,
			withBundledBun: unchangedEnv,
		});

		expect(entry.Path?.split(";")).toEqual([portableBin, system32, gitCmd]);
		expect(windowsWhich("bash", entry.Path ?? "")).toBe(portableBash);
	});

	it("leaves PATH unchanged when the bash lives in a usr\\bin with coreutils that would shadow System32", () => {
		const usrBin = join(root, "msys64", "usr", "bin");
		const usrBash = fakeExe(usrBin, "bash");
		fakeExe(usrBin, "sh");
		fakeExe(usrBin, "find");
		fakeExe(usrBin, "sort");

		const entry = kernelPathEntry({
			platform: "win32",
			env: { Path: inheritedPath },
			resolveBash: () => usrBash,
			withBundledBun: unchangedEnv,
		});

		expect(entry).toEqual({});
	});

	it("leaves PATH unchanged when the bash directory has no sh.exe beside it", () => {
		const lone = fakeExe(join(root, "tools"), "bash");

		const entry = kernelPathEntry({
			platform: "win32",
			env: { Path: inheritedPath },
			resolveBash: () => lone,
			withBundledBun: unchangedEnv,
		});

		expect(entry).toEqual({});
	});

	it.each(["darwin", "linux"] as const)("leaves PATH unchanged on %s", (platform) => {
		const entry = kernelPathEntry({
			platform,
			env: { PATH: "/usr/bin:/bin" },
			resolveBash: () => gitBash,
			withBundledBun: unchangedEnv,
		});

		expect(entry).toEqual({});
	});

	it("composes with the bundled bun PATH entry", () => {
		const bunDir = join(root, "senpi-bin");
		const entry = kernelPathEntry({
			platform: "win32",
			env: { Path: inheritedPath },
			resolveBash: () => gitBash,
			withBundledBun: (env) => ({ ...env, Path: [bunDir, env.Path].join(";") }),
		});

		expect(entry.Path?.split(";")).toEqual([gitBin, bunDir, system32, gitCmd]);
	});
});
