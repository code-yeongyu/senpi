// senpi#6362: settings that name an executable or a command line are honoured only from global settings or from a project
// the person trusted. A settings manager created without a trust decision uses the decision the person saved for the folder.
// Security contract: each family below must not run a project-named program from an untrusted project, and must still run
// it from a trusted one.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../../src/config.ts";
import { EXECUTABLE_SETTING_PATHS, executableSettingPathsIn } from "../../../src/core/project-executable-settings.ts";
import { registerCursorCliOauthExtension } from "../../../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import { loadCursorCliOauthProviderSettingsFromDisk } from "../../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createLocalBashOperations } from "../../../src/core/tools/bash.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";

const scratch: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Rig {
	readonly project: string;
	readonly agentDir: string;
	readonly marker: string;
	readonly program: string;
	trust(): Promise<void>;
}

/** A project whose settings file names `program`, a fake executable that only records that it ran. */
function rig(
	projectSettings: (program: string) => Record<string, unknown>,
	agentDir = mkdtempSync(join(tmpdir(), "s6362-agent-")),
): Rig {
	const root = mkdtempSync(join(tmpdir(), "s6362-"));
	scratch.push(root, agentDir);
	const project = join(root, "project");
	mkdirSync(join(project, ".senpi"), { recursive: true });
	const marker = join(root, "MARKER");
	const program = join(root, "program");
	writeFileSync(
		program,
		`#!/bin/sh\necho "$*" >> '${marker}'\nif [ "$1" = "models" ]; then echo "auto - Auto"; fi\nif [ "$1" = "-c" ]; then exec /bin/sh "$@"; fi\nexit 0\n`,
	);
	chmodSync(program, 0o755);
	writeFileSync(join(project, ".senpi", "settings.json"), JSON.stringify(projectSettings(program)));
	return { project, agentDir, marker, program, trust: () => new ProjectTrustStore(agentDir).set(project, true) };
}

describe("settings that name an executable (senpi#6362)", () => {
	it("are ignored from an untrusted project, with a reason, and applied once the project is trusted", async () => {
		const r = rig((program) => ({
			shellPath: program,
			shellCommandPrefix: "echo prefixed",
			npmCommand: [program],
			externalEditor: program,
			cursorCliOauthProvider: { enabled: true, executablePath: program },
		}));
		const untrusted = SettingsManager.create(r.project, r.agentDir);
		expect([untrusted.getShellPath(), untrusted.getShellCommandPrefix(), untrusted.getNpmCommand()]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		const ignored = untrusted.drainErrors();
		const reasons = ignored.map((error) => error.error.message);
		for (const key of EXECUTABLE_SETTING_PATHS)
			expect(reasons.some((reason) => reason.includes(key) && reason.includes("not trusted"))).toBe(true);
		// senpi#7633: each notice names the file as the project knows it, never by its absolute path.
		for (const error of ignored) {
			expect(error.error.message).toContain(join(".senpi", "settings.json"));
			expect([error.path, error.error.message].join("\n")).not.toContain(r.project);
		}

		await r.trust();
		const trusted = SettingsManager.create(r.project, r.agentDir);
		expect(trusted.getShellPath()).toBe(r.program);
		expect(trusted.getNpmCommand()).toEqual([r.program]);
	});

	it("shellPath: the shell an untrusted project names never runs; a trusted project's does", async () => {
		const r = rig((program) => ({ shellPath: program }));
		const run = async () => {
			const shellPath = SettingsManager.create(r.project, r.agentDir).getShellPath();
			await createLocalBashOperations({ shellPath }).exec("true", r.project, { onData: () => {} });
		};
		await run();
		expect(existsSync(r.marker)).toBe(false);
		await r.trust();
		await run();
		expect(existsSync(r.marker)).toBe(true);
	});

	it("npmCommand: the package manager never runs a command an untrusted project names", async () => {
		const r = rig((program) => ({ npmCommand: [program] }));
		const commandFor = async () => {
			const manager = new DefaultPackageManager({
				cwd: r.project,
				agentDir: r.agentDir,
				settingsManager: SettingsManager.create(r.project, r.agentDir),
			});
			const runCommand = vi
				.spyOn(manager as unknown as { runCommand: (...args: unknown[]) => Promise<void> }, "runCommand")
				.mockResolvedValue(undefined);
			await manager.install("npm:@scope/pkg");
			return (runCommand.mock.calls[0] as unknown[] | undefined)?.[0];
		};
		expect(await commandFor()).not.toBe(r.program);
		await r.trust();
		expect(await commandFor()).toBe(r.program);
	});

	it("CLI provider settings: an untrusted project can neither enable the Cursor CLI lane nor choose its executable", async () => {
		const r = rig(
			(program) => ({
				cursorCliOauthProvider: { enabled: true, executablePath: program },
			}),
			getAgentDir(),
		);
		expect(loadCursorCliOauthProviderSettingsFromDisk(r.project)).toMatchObject({
			enabled: false,
			executablePath: undefined,
		});

		await r.trust();
		expect(loadCursorCliOauthProviderSettingsFromDisk(r.project)).toMatchObject({
			enabled: true,
			executablePath: r.program,
		});
	});

	it("CLI provider settings: a trusted project's provider still runs its executable at startup", async () => {
		const r = rig(
			(program) => ({ cursorCliOauthProvider: { enabled: true, executablePath: program } }),
			getAgentDir(),
		);
		await r.trust();
		const store = new InMemoryCredentialStore();
		await store.modify("cursor", async () => ({
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 3_600_000,
		}));
		const second = new Promise<void>((resolve) => {
			let registrations = 0;
			const pi = new Proxy(
				{
					registerProvider: () => {
						registrations++;
						if (registrations === 2) resolve();
					},
				},
				{ get: (target, key) => (key in target ? Reflect.get(target, key) : () => {}) },
			) as unknown as ExtensionAPI;
			registerCursorCliOauthExtension(pi, { cwd: r.project, agentDir: r.agentDir, store });
		});
		await second;
		expect(readFileSync(r.marker, "utf8")).toContain("models");
	});
});

// senpi#7635: the rule holds on every read of the project file, not only the first one.
describe("settings that name an executable, when the project file is read again (senpi#7635)", () => {
	const everyKey = (program: string) => ({
		shellPath: program,
		shellCommandPrefix: "echo prefixed",
		npmCommand: [program],
		externalEditor: program,
		cursorCliOauthProvider: { enabled: true, executablePath: program },
	});

	it("stay ignored after reload(), with a reason, and apply on the reload after the project is trusted", async () => {
		const r = rig(everyKey);
		const manager = SettingsManager.create(r.project, r.agentDir);
		manager.drainErrors();
		await manager.reload();
		expect(executableSettingPathsIn(manager.getProjectSettings())).toEqual([]);
		expect([manager.getShellPath(), manager.getShellCommandPrefix(), manager.getNpmCommand()]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		const reasons = manager.drainErrors().map((error) => error.error.message);
		for (const key of EXECUTABLE_SETTING_PATHS)
			expect(reasons.some((reason) => reason.includes(key) && reason.includes("not trusted"))).toBe(true);

		await r.trust();
		await manager.reload();
		expect(manager.getShellPath()).toBe(r.program);
		expect(manager.getNpmCommand()).toEqual([r.program]);
	});

	it("stay ignored when setProjectTrusted(true) reads the project file again", () => {
		const r = rig(everyKey);
		const manager = SettingsManager.create(r.project, r.agentDir);
		manager.setProjectTrusted(false);
		manager.setProjectTrusted(true);
		expect(executableSettingPathsIn(manager.getProjectSettings())).toEqual([]);
		expect(manager.getShellPath()).toBeUndefined();
	});

	it("a session made without a settingsManager never runs the shell an untrusted project names, nor after a reload", async () => {
		const r = rig(everyKey, getAgentDir());
		const { session } = await createAgentSession({
			cwd: r.project,
			agentDir: r.agentDir,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			await session.executeBash("true");
			await session.reload();
			await session.executeBash("true");
			expect(existsSync(r.marker)).toBe(false);
			// A cached settings reader of the same project still keeps the Cursor CLI lane off after the reload.
			expect(loadCursorCliOauthProviderSettingsFromDisk(r.project)).toMatchObject({
				enabled: false,
				executablePath: undefined,
			});
		} finally {
			session.dispose();
		}
	});
});
