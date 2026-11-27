// senpi#6362: settings that name an executable or a command line are honoured only from global settings or from a project
// the person trusted. Project trust defaults to false for every settings reader that does not pass a trust decision.
// Security contract: each family below must not run a project-named program from an untrusted project, and must still run
// it from a trusted one.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../../src/config.ts";
import { loadAnthropicSubscriptionProviderSettingsFromDisk } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { registerCursorCliOauthExtension } from "../../../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import { loadCursorCliOauthProviderSettingsFromDisk } from "../../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
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
function rig(projectSettings: (program: string) => Record<string, unknown>, agentDir = mkdtempSync(join(tmpdir(), "s6362-agent-"))): Rig {
	const root = mkdtempSync(join(tmpdir(), "s6362-"));
	scratch.push(root, agentDir);
	const project = join(root, "project");
	mkdirSync(join(project, ".senpi"), { recursive: true });
	const marker = join(root, "MARKER");
	const program = join(root, "program");
	writeFileSync(program, `#!/bin/sh\necho "$*" >> '${marker}'\nif [ "$1" = "models" ]; then echo "auto - Auto"; fi\nif [ "$1" = "-c" ]; then exec /bin/sh "$@"; fi\nexit 0\n`);
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
		}));
		const untrusted = SettingsManager.create(r.project, r.agentDir);
		expect([untrusted.getShellPath(), untrusted.getShellCommandPrefix(), untrusted.getNpmCommand()]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		const reasons = untrusted.drainErrors().map((error) => error.error.message);
		for (const key of ["shellPath", "shellCommandPrefix", "npmCommand", "externalEditor"])
			expect(reasons.some((reason) => reason.includes(key) && reason.includes("not trusted"))).toBe(true);

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
			const runCommand = vi.spyOn(manager as never, "runCommand").mockResolvedValue(undefined as never);
			await manager.install("npm:@scope/pkg");
			return (runCommand.mock.calls[0] as unknown[] | undefined)?.[0];
		};
		expect(await commandFor()).not.toBe(r.program);
		await r.trust();
		expect(await commandFor()).toBe(r.program);
	});

	it("CLI provider settings: an untrusted project can neither enable a provider nor choose its executable", async () => {
		const r = rig(
			(program) => ({
				cursorCliOauthProvider: { enabled: true, executablePath: program },
				anthropicSubscriptionProvider: { enabled: true },
			}),
			getAgentDir(),
		);
		expect(loadCursorCliOauthProviderSettingsFromDisk(r.project)).toMatchObject({ enabled: false, executablePath: undefined });
		expect(loadAnthropicSubscriptionProviderSettingsFromDisk(r.project).enabled).not.toBe(true);

		await r.trust();
		expect(loadCursorCliOauthProviderSettingsFromDisk(r.project)).toMatchObject({ enabled: true, executablePath: r.program });
		expect(loadAnthropicSubscriptionProviderSettingsFromDisk(r.project).enabled).toBe(true);
	});

	it("CLI provider settings: a trusted project's provider still runs its executable at startup", async () => {
		const r = rig((program) => ({ cursorCliOauthProvider: { enabled: true, executablePath: program } }), getAgentDir());
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
