import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	AgentSessionServices,
	CreateAgentSessionServicesOptions,
	createAgentSessionFromServices as createAgentSessionFromServicesType,
} from "../src/core/agent-session-services.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "../src/extensions/llama/provider.ts";

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

describe("--list-models fast path", () => {
	const tempDirs: string[] = [];
	let originalAgentDir: string | undefined;
	let originalOpenaiApiKey: string | undefined;
	let originalCwd = process.cwd();
	let originalExitCode: typeof process.exitCode = process.exitCode;

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalOpenaiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = originalOpenaiApiKey;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-list-models-fast-path-"));
		tempDirs.push(dir);
		return dir;
	}

	it("lists models without creating an agent session", async () => {
		vi.resetModules();
		const createAgentSessionFromServicesMock = vi.fn<typeof createAgentSessionFromServicesType>(async () => {
			throw new Error("--list-models should not create an agent session");
		});
		vi.doMock("../src/core/agent-session-services.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/core/agent-session-services.ts")>();
			return {
				...actual,
				createAgentSessionFromServices: createAgentSessionFromServicesMock,
			};
		});
		const { main } = await import("../src/main.ts");

		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalOpenaiApiKey = process.env.OPENAI_API_KEY;
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.OPENAI_API_KEY = "fake-openai-key";
		process.exitCode = undefined;
		process.chdir(projectDir);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
			throw new ProcessExitError(code);
		});

		await expect(main(["--list-models", "gpt-5.4"])).rejects.toMatchObject({ code: 0 });
		expect(createAgentSessionFromServicesMock).not.toHaveBeenCalled();
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("gpt-5.4");
	});

	it("lists built-in catalog models without configured credentials", async () => {
		vi.resetModules();
		const { main } = await import("../src/main.ts");

		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalOpenaiApiKey = process.env.OPENAI_API_KEY;
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		delete process.env.OPENAI_API_KEY;
		process.exitCode = undefined;
		process.chdir(projectDir);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
			throw new ProcessExitError(code);
		});

		await expect(main(["--list-models", "gpt-5.4"])).rejects.toMatchObject({ code: 0 });
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("gpt-5.4");
	});

	it("registers built-in extension providers for --list-models", async () => {
		vi.resetModules();
		let capturedServices: AgentSessionServices | undefined;
		vi.doMock("../src/core/agent-session-services.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/core/agent-session-services.ts")>();
			return {
				...actual,
				createAgentSessionServices: async (options: CreateAgentSessionServicesOptions) => {
					capturedServices = await actual.createAgentSessionServices(options);
					return capturedServices;
				},
			};
		});
		const { main } = await import("../src/main.ts");

		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		process.chdir(projectDir);

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
			throw new ProcessExitError(code);
		});

		await expect(main(["--list-models"])).rejects.toMatchObject({ code: 0 });
		expect(capturedServices?.modelRuntime.getProviders().map((provider) => provider.id)).toContain(LLAMA_PROVIDER_ID);
	});

	it("lets caller extension factories override built-in providers for --list-models", async () => {
		vi.resetModules();
		let capturedServices: AgentSessionServices | undefined;
		vi.doMock("../src/core/agent-session-services.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/core/agent-session-services.ts")>();
			return {
				...actual,
				createAgentSessionServices: async (options: CreateAgentSessionServicesOptions) => {
					capturedServices = await actual.createAgentSessionServices(options);
					return capturedServices;
				},
			};
		});
		const { main } = await import("../src/main.ts");

		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		process.chdir(projectDir);

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
			throw new ProcessExitError(code);
		});

		await expect(
			main(["--list-models"], {
				extensionFactories: [
					{
						name: "llama-override",
						factory: (pi) => {
							pi.registerProvider({ ...createLlamaProvider().provider, name: "override llama" });
						},
						hidden: true,
					},
				],
			}),
		).rejects.toMatchObject({ code: 0 });
		expect(capturedServices?.modelRuntime.getProvider(LLAMA_PROVIDER_ID)?.name).toBe("override llama");
	});

	it("loads only model-listing resources for --list-models", async () => {
		vi.resetModules();
		let capturedOptions: CreateAgentSessionServicesOptions | undefined;
		vi.doMock("../src/core/agent-session-services.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/core/agent-session-services.ts")>();
			return {
				...actual,
				createAgentSessionServices: async (options: CreateAgentSessionServicesOptions) => {
					capturedOptions = options;
					return actual.createAgentSessionServices(options);
				},
			};
		});
		const { main } = await import("../src/main.ts");

		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		process.chdir(projectDir);

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
			throw new ProcessExitError(code);
		});

		await expect(main(["--list-models", "mock"])).rejects.toMatchObject({ code: 0 });
		expect(capturedOptions?.resourceLoaderOptions).toMatchObject({
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	});
});
