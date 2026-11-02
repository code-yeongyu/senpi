import { describe, expect, it } from "vitest";
import {
	CmdCliNotInstalledError,
	defaultCmdCliExecutableDeps,
	resolveCmdCliExecutable,
} from "../../src/core/extensions/builtin/cmd-cli/executable.ts";

describe("cmd-cli executable", () => {
	it("resolves from SENPI_CMD_CLI_EXECUTABLE env var", () => {
		const executable = resolveCmdCliExecutable({
			env: (name) => (name === "SENPI_CMD_CLI_EXECUTABLE" ? "/custom/path/cmd" : undefined),
			isExecutableFile: (path) => path === "/custom/path/cmd",
		});
		expect(executable).toBe("/custom/path/cmd");
	});

	it("resolves from CMD_EXECUTABLE env var", () => {
		const executable = resolveCmdCliExecutable({
			env: (name) => (name === "CMD_EXECUTABLE" ? "/bin/cmd" : undefined),
			isExecutableFile: (path) => path === "/bin/cmd",
		});
		expect(executable).toBe("/bin/cmd");
	});

	it("resolves from settings.executablePath", () => {
		const executable = resolveCmdCliExecutable({
			settings: { executablePath: "/opt/cmd/bin/cmd" },
			isExecutableFile: (path) => path === "/opt/cmd/bin/cmd",
		});
		expect(executable).toBe("/opt/cmd/bin/cmd");
	});

	it("resolves from PATH scanning", () => {
		const executable = resolveCmdCliExecutable({
			env: (name) => (name === "PATH" ? "/usr/local/bin:/usr/bin" : undefined),
			pathDelimiter: ":",
			isExecutableFile: (path) => path === "/usr/bin/cmd",
		});
		expect(executable).toBe("/usr/bin/cmd");
	});

	it("throws CmdCliNotInstalledError with kind=binary_missing when not found", () => {
		let thrown: unknown;
		try {
			resolveCmdCliExecutable({
				env: () => undefined,
				settings: {},
				isExecutableFile: () => false,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(CmdCliNotInstalledError);
		expect((thrown as CmdCliNotInstalledError).kind).toBe("binary_missing");
	});

	it("skips non-executable files in candidates and PATH", () => {
		expect(() =>
			resolveCmdCliExecutable({
				env: (name) => (name === "PATH" ? "/usr/bin" : "/env/cmd"),
				isExecutableFile: () => false,
			}),
		).toThrow(CmdCliNotInstalledError);
	});

	it("provides working defaultCmdCliExecutableDeps", () => {
		const deps = defaultCmdCliExecutableDeps();
		expect(typeof deps.env).toBe("function");
		expect(typeof deps.isExecutableFile).toBe("function");
		expect(typeof deps.pathDelimiter).toBe("string");
	});
});
