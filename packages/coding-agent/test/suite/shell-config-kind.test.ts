import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getShellConfig, resolveShellKind } from "../../src/utils/shell.ts";

/**
 * Todo 18 shell-resolution requirements: an explicit shell path must be resolved
 * by KIND so cmd.exe uses `/c`, PowerShell uses `-NoProfile -Command`, and
 * bash/sh use `-c`/`-s`; and `SENPI_GIT_BASH_PATH` must be honored ahead of the
 * Git Bash known-location probe. These assertions are cross-platform because
 * `getShellConfig` only inspects the supplied path string, not the host OS.
 */
describe("shell config kind resolution", () => {
	let dir: string;
	const savedEnv = process.env.SENPI_GIT_BASH_PATH;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-shell-"));
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.SENPI_GIT_BASH_PATH;
		else process.env.SENPI_GIT_BASH_PATH = savedEnv;
		rmSync(dir, { recursive: true, force: true });
	});

	it("classifies shell kinds from the executable name", () => {
		expect(resolveShellKind("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
		expect(resolveShellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
		expect(resolveShellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
		expect(resolveShellKind("/usr/bin/bash")).toBe("bash");
		expect(resolveShellKind("/bin/sh")).toBe("sh");
	});

	it("resolves cmd.exe with /c transport", () => {
		const cmd = join(dir, "cmd.exe");
		writeFileSync(cmd, "");
		const config = getShellConfig(cmd);
		expect(config.kind).toBe("cmd");
		expect(config.args).toEqual(["/c"]);
		expect(config.commandTransport ?? "argv").toBe("argv");
	});

	it("resolves powershell with -NoProfile -Command", () => {
		const pwsh = join(dir, "pwsh.exe");
		writeFileSync(pwsh, "");
		const config = getShellConfig(pwsh);
		expect(config.kind).toBe("powershell");
		expect(config.args).toEqual(["-NoProfile", "-Command"]);
	});

	it("resolves an explicit bash path with -c", () => {
		const bash = join(dir, "bash.exe");
		writeFileSync(bash, "");
		const config = getShellConfig(bash);
		expect(config.kind).toBe("bash");
		expect(config.args).toEqual(["-c"]);
	});

	it("honors SENPI_GIT_BASH_PATH ahead of other resolution", () => {
		const bash = join(dir, "git-bash.exe");
		writeFileSync(bash, "");
		process.env.SENPI_GIT_BASH_PATH = bash;
		const config = getShellConfig();
		expect(config.shell).toBe(bash);
		expect(config.kind).toBe("bash");
	});
});
