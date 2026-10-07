import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { resolveDiscoveredResourcePaths } from "../../../src/core/discovered-resource-scope.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { GENERATED_SHIM_BANNER } from "../../../src/core/generated-shim-banner.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import { readPiManifest } from "../../../src/core/pi-manifest.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { SourceInfo } from "../../../src/core/source-info.ts";
import { mapSkillScope } from "../../../src/modes/app-server/server/skills.ts";
import { createTestExtensionsResult } from "../../utilities.ts";

const EXTENSION_SOURCE = "export default function () {}";

function writeSkill(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const skillPath = join(dir, "SKILL.md");
	writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${name}\n---\n${name} body\n`);
	return skillPath;
}

function writePackage(
	root: string,
	manifest: Record<string, unknown>,
	name = "system-package",
): { extensionPath: string; skillPath: string } {
	mkdirSync(join(root, "extensions"), { recursive: true });
	const extensionPath = join(root, "extensions", "index.ts");
	writeFileSync(extensionPath, EXTENSION_SOURCE);
	const skillPath = writeSkill(join(root, "skills", "packaged-skill"), "packaged-skill");
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name, pi: { extensions: ["./extensions/index.ts"], skills: ["./skills"], ...manifest } }),
	);
	return { extensionPath, skillPath };
}

function sourceInfo(path: string, overrides: Partial<SourceInfo>): SourceInfo {
	return { path, source: "local", scope: "temporary", origin: "top-level", ...overrides };
}

describe("system provenance scope (#1640)", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-1640-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("pi manifest", () => {
		it("parses a boolean pi.system flag and ignores any other type", () => {
			const flagged = join(tempDir, "flagged");
			const truthy = join(tempDir, "truthy-string");
			mkdirSync(flagged, { recursive: true });
			mkdirSync(truthy, { recursive: true });
			writeFileSync(join(flagged, "package.json"), JSON.stringify({ pi: { system: true, skills: ["./skills"] } }));
			writeFileSync(join(truthy, "package.json"), JSON.stringify({ pi: { system: "yes", skills: ["./skills"] } }));

			expect(readPiManifest(join(flagged, "package.json"))).toEqual({ system: true, skills: ["./skills"] });
			expect(readPiManifest(join(truthy, "package.json"))).toEqual({ skills: ["./skills"] });
		});
	});

	describe("package manager", () => {
		it("resolves a command-line package that declares pi.system to the system scope", async () => {
			const root = join(tempDir, "cli-system-package");
			const { extensionPath, skillPath } = writePackage(root, { system: true });
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
			});

			const resolved = await packageManager.resolveExtensionSources([root], { temporary: true });

			expect(resolved.extensions.find((resource) => resource.path === extensionPath)?.metadata).toMatchObject({
				scope: "system",
				origin: "package",
				baseDir: root,
			});
			expect(resolved.skills.find((resource) => resource.path === skillPath)?.metadata.scope).toBe("system");
		});

		it("keeps the installed scope for a settings package that declares pi.system", async () => {
			const root = join(tempDir, "settings-system-package");
			const { extensionPath } = writePackage(root, { system: true });
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ packages: [root] }),
			});

			const resolved = await packageManager.resolve();

			expect(resolved.extensions.find((resource) => resource.path === extensionPath)?.metadata.scope).toBe("user");
		});

		it("leaves a command-line package without the flag temporary", async () => {
			const root = join(tempDir, "cli-plain-package");
			const { extensionPath } = writePackage(root, {});
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
			});

			const resolved = await packageManager.resolveExtensionSources([root], { temporary: true });

			expect(resolved.extensions.find((resource) => resource.path === extensionPath)?.metadata.scope).toBe(
				"temporary",
			);
		});
	});

	describe("resource loader", () => {
		it("tags builtin extensions and command-line system package resources with the system scope", async () => {
			const root = join(tempDir, "system-package");
			const { extensionPath, skillPath } = writePackage(root, { system: true });
			const adHocExtension = join(tempDir, "ad-hoc.ts");
			writeFileSync(adHocExtension, EXTENSION_SOURCE);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ enabledBuiltinExtensions: ["todowrite"] }),
				additionalExtensionPaths: [root, adHocExtension],
			});

			await loader.reload();

			const extensions = loader.getExtensions().extensions;
			expect(extensions.find((extension) => extension.path === "<builtin:todowrite>")?.sourceInfo).toMatchObject({
				source: "builtin",
				scope: "system",
			});
			expect(extensions.find((extension) => extension.path === extensionPath)?.sourceInfo).toMatchObject({
				source: "cli",
				scope: "system",
				origin: "top-level",
				baseDir: root,
			});
			expect(extensions.find((extension) => extension.path === adHocExtension)?.sourceInfo).toMatchObject({
				source: "cli",
				scope: "temporary",
			});
			expect(loader.getSkills().skills.find((skill) => skill.filePath === skillPath)?.sourceInfo).toMatchObject({
				source: "cli",
				scope: "system",
			});
		});

		it("tags generated global-default shims as system but user-authored agent extensions as user", async () => {
			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			const shimPath = join(extensionsDir, "diff.js");
			const diffModule = pathToFileURL(resolve("src", "core", "extensions", "builtin", "diff.ts")).href;
			writeFileSync(shimPath, `${GENERATED_SHIM_BANNER}export { default } from ${JSON.stringify(diffModule)};\n`);
			const userPath = join(extensionsDir, "mine.js");
			writeFileSync(userPath, EXTENSION_SOURCE);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ enabledBuiltinExtensions: [] }),
			});

			await loader.reload();

			const extensions = loader.getExtensions().extensions;
			expect(extensions.find((extension) => extension.path === shimPath)?.sourceInfo).toMatchObject({
				source: "builtin",
				scope: "system",
				baseDir: extensionsDir,
			});
			expect(extensions.find((extension) => extension.path === userPath)?.sourceInfo).toMatchObject({
				source: "auto",
				scope: "user",
			});
		});

		it("keeps command-line precedence for a system package over settings packages", async () => {
			const systemRoot = join(tempDir, "system-package");
			const settingsRoot = join(tempDir, "settings-package");
			const { extensionPath: systemExtension } = writePackage(systemRoot, { system: true });
			const { extensionPath: settingsExtension } = writePackage(settingsRoot, {}, "settings-package");
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ enabledBuiltinExtensions: [], packages: [settingsRoot] }),
				additionalExtensionPaths: [systemRoot],
			});

			await loader.reload();

			const paths = loader.getExtensions().extensions.map((extension) => extension.path);
			expect(paths.indexOf(systemExtension)).toBeGreaterThanOrEqual(0);
			expect(paths.indexOf(systemExtension)).toBeLessThan(paths.indexOf(settingsExtension));
		});
	});

	describe("discovered resource scope", () => {
		const builtin = {
			path: "<builtin:imagegen>",
			sourceInfo: sourceInfo("<builtin:imagegen>", { source: "builtin", scope: "system" }),
		};
		const systemPackage = {
			path: "/pkg/extensions/harness.js",
			sourceInfo: sourceInfo("/pkg/extensions/harness.js", { source: "cli", scope: "system", baseDir: "/pkg" }),
		};
		const adHoc = {
			path: "/tmp/ad-hoc/index.ts",
			sourceInfo: sourceInfo("/tmp/ad-hoc/index.ts", { source: "cli", scope: "temporary", baseDir: "/tmp/ad-hoc" }),
		};
		const extensions = [builtin, systemPackage, adHoc];

		it("inherits the system scope from a builtin contributor", () => {
			const [entry] = resolveDiscoveredResourcePaths(
				[{ path: "/embedded/skill/SKILL.md", extensionPath: builtin.path }],
				extensions,
			);

			expect(entry).toEqual({
				path: "/embedded/skill/SKILL.md",
				metadata: {
					source: "extension:builtin:imagegen",
					scope: "system",
					origin: "top-level",
					baseDir: undefined,
				},
			});
		});

		it("inherits the system scope only for paths inside the system package", () => {
			const [inside, outside] = resolveDiscoveredResourcePaths(
				[
					{ path: "/pkg/skills-conditional/x/SKILL.md", extensionPath: systemPackage.path },
					{ path: "/home/me/memory/skills", extensionPath: systemPackage.path },
				],
				extensions,
			);

			expect(inside?.metadata).toMatchObject({
				source: "extension:harness",
				scope: "system",
				baseDir: "/pkg/extensions",
			});
			expect(outside?.metadata).toMatchObject({ source: "extension:harness", scope: "temporary" });
		});

		it("honors an explicit scope over inheritance", () => {
			const [entry] = resolveDiscoveredResourcePaths(
				[{ path: "/pkg/skills-conditional/x/SKILL.md", extensionPath: systemPackage.path, scope: "user" }],
				extensions,
			);

			expect(entry?.metadata.scope).toBe("user");
		});

		it("keeps contributions from ad-hoc or unknown extensions temporary", () => {
			const [known, unknown] = resolveDiscoveredResourcePaths(
				[
					{ path: "/tmp/ad-hoc/skills", extensionPath: adHoc.path },
					{ path: "/somewhere/skills", extensionPath: "/not/loaded.ts" },
				],
				extensions,
			);

			expect(known?.metadata).toMatchObject({ source: "extension:index", scope: "temporary" });
			expect(unknown?.metadata).toMatchObject({ source: "extension:loaded", scope: "temporary" });
		});
	});

	describe("resources_discover entries", () => {
		it("advertises scoped entry support on the event so handlers can feature-detect it", async () => {
			const seen: unknown[] = [];
			const factory: ExtensionFactory = (pi) => {
				pi.on("resources_discover", (event) => {
					seen.push(event);
					return undefined;
				});
			};
			const extensionsResult = await createTestExtensionsResult([{ factory, path: "<test:capability>" }], cwd);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				SessionManager.inMemory(),
				ModelRegistry.inMemory(AuthStorage.inMemory()),
			);

			await runner.emitResourcesDiscover(cwd, "startup");

			expect(seen).toEqual([{ type: "resources_discover", cwd, reason: "startup", scopedEntries: true }]);
		});

		it("accepts string paths and { path, scope } objects from one handler", async () => {
			const factory: ExtensionFactory = (pi) => {
				pi.on("resources_discover", () => ({
					skillPaths: ["/plain/skills", { path: "/tagged/skills", scope: "user" }],
					promptPaths: [{ path: "/tagged/prompts", scope: "project" }],
				}));
			};
			const extensionsResult = await createTestExtensionsResult([{ factory, path: "<test:discover>" }], cwd);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				SessionManager.inMemory(),
				ModelRegistry.inMemory(AuthStorage.inMemory()),
			);

			const resources = await runner.emitResourcesDiscover(cwd, "startup");

			expect(resources.skillPaths).toEqual([
				{ path: "/plain/skills", extensionPath: "<test:discover>" },
				{ path: "/tagged/skills", extensionPath: "<test:discover>", scope: "user" },
			]);
			expect(resources.promptPaths).toEqual([
				{ path: "/tagged/prompts", extensionPath: "<test:discover>", scope: "project" },
			]);
		});
	});

	describe("app-server skill scope", () => {
		it("maps the system scope to the app-server system scope", () => {
			expect(mapSkillScope("system")).toBe("system");
			expect(mapSkillScope("temporary")).toBe("system");
			expect(mapSkillScope("user")).toBe("user");
			expect(mapSkillScope("project")).toBe("repo");
		});
	});
});
