import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CursorAgentExecutableDeps,
	CursorAgentNotInstalledError,
	probeCursorAgentVersion,
	resolveCursorAgentExecutable,
	type VersionProbeDeps,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/executable.ts";

type DirectoryEntry = ReturnType<CursorAgentExecutableDeps["readDirectory"]>[number];

type FakeFs = {
	executables?: string[];
	directories?: Record<string, DirectoryEntry[]>;
};

function makeDeps(overrides: Partial<CursorAgentExecutableDeps> = {}, fs: FakeFs = {}): CursorAgentExecutableDeps {
	const executables = new Set(fs.executables ?? []);
	const directories = fs.directories ?? {};
	return {
		env: () => undefined,
		settings: {},
		homeDirectory: "/home/tester",
		pathDelimiter: ":",
		isExecutableFile: (candidate) => executables.has(candidate),
		readDirectory: (directory) => {
			const entries = directories[directory];
			if (!entries) throw new Error(`ENOENT: ${directory}`);
			return entries;
		},
		...overrides,
	};
}

describe("resolveCursorAgentExecutable", () => {
	it("prefers SENPI_CURSOR_CLI_OAUTH_EXECUTABLE", () => {
		const candidate = "/opt/senpi/cursor-agent";
		const deps = makeDeps(
			{
				env: (name) => {
					if (name === "SENPI_CURSOR_CLI_OAUTH_EXECUTABLE") return candidate;
					if (name === "CURSOR_AGENT_EXECUTABLE") return "/opt/cursor/cursor-agent";
					if (name === "PATH") return "/usr/bin";
					return undefined;
				},
				settings: { executablePath: "/settings/cursor-agent" },
			},
			{ executables: [candidate, "/opt/cursor/cursor-agent", "/settings/cursor-agent", "/usr/bin/cursor-agent"] },
		);

		expect(resolveCursorAgentExecutable(deps)).toBe(candidate);
	});

	it("uses CURSOR_AGENT_EXECUTABLE when the senpi override is absent", () => {
		const candidate = "/opt/cursor/cursor-agent";
		const deps = makeDeps(
			{
				env: (name) => (name === "CURSOR_AGENT_EXECUTABLE" ? candidate : undefined),
				settings: { executablePath: "/settings/cursor-agent" },
			},
			{ executables: [candidate, "/settings/cursor-agent"] },
		);

		expect(resolveCursorAgentExecutable(deps)).toBe(candidate);
	});

	it("uses the settings executablePath after invalid environment candidates", () => {
		const candidate = "/settings/cursor-agent";
		const deps = makeDeps(
			{
				env: (name) => {
					if (name === "SENPI_CURSOR_CLI_OAUTH_EXECUTABLE") return "/missing/senpi";
					if (name === "CURSOR_AGENT_EXECUTABLE") return "/non-executable/cursor-agent";
					return undefined;
				},
				settings: { executablePath: candidate },
			},
			{ executables: [candidate] },
		);

		expect(resolveCursorAgentExecutable(deps)).toBe(candidate);
	});

	it("probes each non-empty PATH entry without invoking which", () => {
		const probes: string[] = [];
		const deps = makeDeps({
			env: (name) => (name === "PATH" ? ":/first/bin::/second/bin:" : undefined),
			isExecutableFile: (candidate) => {
				probes.push(candidate);
				return candidate === "/second/bin/cursor-agent";
			},
		});

		expect(resolveCursorAgentExecutable(deps)).toBe("/second/bin/cursor-agent");
		expect(probes).toEqual(["/first/bin/cursor-agent", "/second/bin/cursor-agent"]);
	});

	it("uses the newest executable from the installed versions directory", () => {
		const versionsDirectory = "/home/tester/.local/share/cursor-agent/versions";
		const deps = makeDeps(
			{},
			{
				executables: [
					`${versionsDirectory}/2026.08.10-old/cursor-agent`,
					`${versionsDirectory}/2026.08.11-new/cursor-agent`,
				],
				directories: {
					[versionsDirectory]: [
						{ name: "README.txt", isDirectory: false },
						{ name: "2026.08.10-old", isDirectory: true },
						{ name: "garbage", isDirectory: false },
						{ name: "2026.08.11-new", isDirectory: true },
						{ name: "zzz-non-executable", isDirectory: true },
					],
				},
			},
		);

		expect(resolveCursorAgentExecutable(deps)).toBe(`${versionsDirectory}/2026.08.11-new/cursor-agent`);
	});

	it("rejects directories and non-executable files and throws typed install guidance", () => {
		const deps = makeDeps({
			env: (name) => {
				if (name === "PATH") return "";
				if (name === "SENPI_CURSOR_CLI_OAUTH_EXECUTABLE") return "/candidate/is-a-directory";
				return undefined;
			},
			settings: { executablePath: "/candidate/not-executable" },
		});

		let thrown: unknown;
		try {
			resolveCursorAgentExecutable(deps);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(CursorAgentNotInstalledError);
		expect(thrown).toMatchObject({ kind: "binary_missing" });
		expect((thrown as Error).message).toContain("curl https://cursor.com/install -fsS | bash");
		expect((thrown as Error).message).toContain("~/.local/bin");
	});
});

describe("probeCursorAgentVersion", () => {
	it("runs --version with a 10 second deadline", async () => {
		const execFile = vi.fn<VersionProbeDeps["execFile"]>((file, args, options, callback) => {
			expect(file).toBe("/opt/cursor-agent");
			expect(args).toEqual(["--version"]);
			expect(options.timeout).toBe(10_000);
			callback(null, "2026.08.11-e8db854\n", "");
		});

		await expect(probeCursorAgentVersion("/opt/cursor-agent", { execFile })).resolves.toBe("2026.08.11-e8db854");
		expect(execFile).toHaveBeenCalledOnce();
	});

	describe("environment", () => {
		const previousSshConnection = process.env.SSH_CONNECTION;

		afterEach(() => {
			if (previousSshConnection === undefined) delete process.env.SSH_CONNECTION;
			else process.env.SSH_CONNECTION = previousSshConnection;
		});

		it("runs --version with the explicit cursor-agent environment rooted in the user HOME", async () => {
			process.env.SSH_CONNECTION = "10.0.0.1 50000 10.0.0.2 22";
			const execFile = vi.fn<VersionProbeDeps["execFile"]>((_file, _args, options, callback) => {
				expect(options.env.HOME).toBe(homedir());
				expect(options.env.AGENT_CLI_CREDENTIAL_STORE).toBe("file");
				expect(options.env).not.toHaveProperty("SSH_CONNECTION");
				callback(null, "2026.08.11-e8db854\n", "");
			});

			await probeCursorAgentVersion("/opt/cursor-agent", { execFile });
			expect(execFile).toHaveBeenCalledOnce();
		});
	});
});
