import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ExtensionToolContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";
import { QueuedFakeKernel } from "./eval/queued-fake.ts";

interface RegisteredHandler {
	readonly event: string;
	readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
}

class FakePi {
	readonly tools: string[] = [];
	readonly handlers: RegisteredHandler[] = [];
	readonly activeTools = new Set<string>(["eval"]);
	registerTool(tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0]): void {
		this.tools.push(tool.name);
		this.activeTools.add(tool.name);
	}
	registerRemovedToolHint(): void {}
	on(event: string, handler: RegisteredHandler["handler"]): void {
		this.handlers.push({ event, handler });
	}
	getActiveTools(): string[] {
		return [...this.activeTools];
	}
	getAllTools(): readonly { readonly name: string }[] {
		return this.tools.map((name) => ({ name }));
	}
	setActiveTools(toolNames: string[]): void {
		this.activeTools.clear();
		for (const toolName of toolNames) this.activeTools.add(toolName);
	}
	async executeTool(): Promise<never> {
		throw new Error("nested tool execution was not expected");
	}
	sendMessage(): void {}
}

const dirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function projectWithSettings(settings: string): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-settings-user-"));
	dirs.push(cwd);
	await mkdir(join(cwd, ".senpi"));
	await writeFile(join(cwd, ".senpi", "codemode.json"), settings);
	return cwd;
}

function context(
	cwd: string,
	ui: { readonly hasUI: boolean; readonly notify: (message: string, type?: string) => void },
	projectTrusted: boolean | "host-cannot-tell" = true,
) {
	const base = fakeExtensionContext();
	const ctx: ExtensionToolContext = {
		...base,
		cwd,
		hasUI: ui.hasUI,
		mode: ui.hasUI ? "tui" : "print",
		ui: { ...base.ui, notify: ui.notify },
		sessionManager: {
			...base.sessionManager,
			getSessionId: () => "settings-user-session",
			getSessionFile: () => join(cwd, "session.jsonl"),
		},
	};
	if (projectTrusted === "host-cannot-tell") {
		// A host context that predates the trust query, like the bundled-package probe in coding-agent's suite.
		Reflect.deleteProperty(ctx, "isProjectTrusted");
	} else {
		ctx.isProjectTrusted = () => projectTrusted;
	}
	return ctx;
}

async function startSession(ctx: ExtensionContext): Promise<void> {
	const pi = new FakePi();
	const kernel = new QueuedFakeKernel();
	senpiCodemode(pi, {
		createSessionManager: () => ({
			getKernel: async () => kernel,
			dispose: async () => {},
			complete: async () => ({ text: "", details: { model: "unused", structured: false } }),
		}),
	});
	for (const entry of pi.handlers.filter((handler) => handler.event === "session_start")) {
		await entry.handler({ reason: "startup" }, ctx);
	}
}

const unknownKey = JSON.stringify({ languages: { js: true, py: false, rb: false, jl: false }, futureSetting: 1 });

describe("Given a settings file with a problem", () => {
	it("When a session with a UI starts, then the user gets a warning that names the problem", async () => {
		const notices: Array<{ message: string; type: string | undefined }> = [];
		const ctx = context(await projectWithSettings(unknownKey), {
			hasUI: true,
			notify: (message, type) => notices.push({ message, type }),
		});

		await startSession(ctx);

		expect(notices).toEqual([
			expect.objectContaining({ type: "warning", message: expect.stringContaining("futureSetting") }),
		]);
	});

	it("When a print-mode session starts, then the warning goes to stderr", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const ctx = context(await projectWithSettings(unknownKey), { hasUI: false, notify: () => {} });

		await startSession(ctx);
		const written = stderr.mock.calls.map((args) => args.map(String).join(" "));

		expect(written.filter((line) => line.includes("futureSetting"))).toHaveLength(1);
	});

	it("When languages.pyInterpreter names a missing executable, then the warning names the setting", async () => {
		const notices: string[] = [];
		const settings = JSON.stringify({
			languages: { js: true, py: true, rb: false, jl: false, pyInterpreter: "/nonexistent/senpi/python3" },
		});
		const ctx = context(await projectWithSettings(settings), {
			hasUI: true,
			notify: (message) => notices.push(message),
		});

		await startSession(ctx);

		expect(notices).toEqual([expect.stringContaining('languages.pyInterpreter "/nonexistent/senpi/python3"')]);
	});

	it("When the settings file is valid and complete, then the user gets no warning", async () => {
		const notices: string[] = [];
		const ctx = context(
			await projectWithSettings(JSON.stringify({ languages: { js: true, py: false, rb: false, jl: false } })),
			{
				hasUI: true,
				notify: (message) => notices.push(message),
			},
		);

		await startSession(ctx);

		expect(notices).toEqual([]);
	});

	it("When the host cannot tell whether the project is trusted, then the session still starts without a warning", async () => {
		const notices: string[] = [];
		const ctx = context(
			await projectWithSettings(JSON.stringify({ languages: { js: true, py: false, rb: false, jl: false } })),
			{ hasUI: true, notify: (message) => notices.push(message) },
			"host-cannot-tell",
		);

		await startSession(ctx);

		expect(notices).toEqual([]);
	});
});

describe.skipIf(process.platform === "win32")(
	"Given a project settings file that names languages.pyInterpreter",
	() => {
		async function projectNamingInterpreter(): Promise<{ readonly cwd: string; readonly ran: string }> {
			const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-untrusted-"));
			dirs.push(cwd);
			const ran = join(cwd, "interpreter-ran");
			const interpreter = join(cwd, "fake-python");
			await writeFile(interpreter, `#!/bin/sh\ntouch "${ran}"\necho "Python 3.12.0"\n`);
			await chmod(interpreter, 0o755);
			await mkdir(join(cwd, ".senpi"));
			await writeFile(
				join(cwd, ".senpi", "codemode.json"),
				JSON.stringify({ languages: { js: true, py: true, rb: false, jl: false, pyInterpreter: interpreter } }),
			);
			return { cwd, ran };
		}

		it("When the project is not trusted, then the interpreter it names is never run and the user is told why", async () => {
			const project = await projectNamingInterpreter();
			const notices: string[] = [];

			await startSession(context(project.cwd, { hasUI: true, notify: (message) => notices.push(message) }, false));

			expect(existsSync(project.ran)).toBe(false);
			expect(notices).toEqual([
				expect.stringContaining("is ignored because this project is not trusted; it was not run"),
			]);
		});

		it("When the host cannot tell whether the project is trusted, then the interpreter is treated as untrusted and never run", async () => {
			const project = await projectNamingInterpreter();
			const notices: string[] = [];

			await startSession(
				context(project.cwd, { hasUI: true, notify: (message) => notices.push(message) }, "host-cannot-tell"),
			);

			expect(existsSync(project.ran)).toBe(false);
			expect(notices).toEqual([
				expect.stringContaining("is ignored because this project is not trusted; it was not run"),
			]);
		});

		it("When the project is trusted, then the interpreter it names is used", async () => {
			const project = await projectNamingInterpreter();
			const notices: string[] = [];

			await startSession(context(project.cwd, { hasUI: true, notify: (message) => notices.push(message) }, true));

			expect(existsSync(project.ran)).toBe(true);
			expect(notices).toEqual([]);
		});
	},
);
