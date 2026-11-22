import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ImageGenAuthRegistry } from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import { registerImageGenExtension } from "../../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry } from "../../../src/core/extensions/builtin/imagegen/state.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createTestExtensionsResult } from "../../utilities.ts";

/**
 * A compiled Bun binary resolves `import(..., { with: { type: "file" } })` to a Bun locator inside
 * its embedded filesystem: `/$bunfs/root/SKILL-<hash>.md` on POSIX, `B:\~BUN\root\...` on Windows.
 * That path exists only inside the process: existsSync passes, descriptor-based readers get ENOENT,
 * and no client or child process can open it (senpi#3799). The advertised skill path must therefore
 * resolve to a real on-disk file — the shipped sidecar beside the executable, exactly as the codemode
 * bun skill resolves — and a Bun locator must never be contributed.
 */
const createdDirs: string[] = [];

function createTempDir(prefix: string): string {
	const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(path, { recursive: true });
	createdDirs.push(path);
	return path;
}

function stubRegistry(credentialed: boolean): ImageGenAuthRegistry {
	const model = {
		provider: "quotio-openai",
		id: "chat",
		baseUrl: "https://gateway.example.test/v1",
		api: "openai-responses",
	};
	return {
		authStorage: { get: () => undefined },
		getAll: () => (credentialed ? [model] : []),
		getApiKeyAndHeaders: async () =>
			credentialed ? { ok: true, apiKey: "stub-key" } : { ok: false, error: "missing credentials" },
		getProviderAuth: async () => undefined,
	};
}

async function createRunner(factory: ExtensionFactory) {
	const cwd = createTempDir("senpi-3799-imagegen");
	const extensionsResult = await createTestExtensionsResult([{ factory, path: "<builtin:imagegen>" }], cwd);
	const runner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		cwd,
		SessionManager.inMemory(),
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);
	return { cwd, runner };
}

/** A sidecar staged the way `scripts/build-binaries.sh` ships it: `<skill dir>/SKILL.md` beside the executable. */
function stageSidecarSkill(): { sidecarDir: string; sidecarSkill: string } {
	const sidecarDir = createTempDir("senpi-3799-sidecar");
	const sidecarSkill = join(sidecarDir, "SKILL.md");
	writeFileSync(sidecarSkill, "---\nname: gpt-image-gen\ndescription: bundled skill\n---\nsidecar body\n");
	return { sidecarDir, sidecarSkill };
}

afterEach(() => {
	setImageGenRegistry(undefined);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const path of createdDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("senpi#3799 imagegen skill advertised at a Bun locator", () => {
	it("contributes the shipped sidecar beside the executable when the module-relative copy is missing", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		setImageGenRegistry(stubRegistry(true));
		const { sidecarDir, sidecarSkill } = stageSidecarSkill();
		const missingBaseDir = createTempDir("senpi-3799-missing-module-skill");
		const factory: ExtensionFactory = (pi) =>
			registerImageGenExtension(pi, missingBaseDir, { shippedSkillDir: sidecarDir });
		const { cwd, runner } = await createRunner(factory);

		const resources = await runner.emitResourcesDiscover(cwd, "startup");
		const paths = resources.skillPaths.map((entry) => entry.path);

		expect(paths).toEqual([sidecarSkill]);
		// The advertised path is a real file: an fd-based reader outside Bun's virtual filesystem opens it.
		const { openSync, readSync, closeSync, fstatSync } = await import("node:fs");
		const fd = openSync(paths[0]!, "r");
		try {
			const size = fstatSync(fd).size;
			const buffer = Buffer.alloc(size);
			readSync(fd, buffer, 0, size, 0);
			expect(buffer.toString("utf8")).toContain("name: gpt-image-gen");
		} finally {
			closeSync(fd);
		}
		expect(paths[0]).not.toMatch(/\$bunfs|~BUN|%7EBUN/);
	});

	it("keeps preferring the module-relative copy over the sidecar when both ship", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		setImageGenRegistry(stubRegistry(true));
		const { sidecarDir } = stageSidecarSkill();
		const moduleBaseDir = createTempDir("senpi-3799-module-skill");
		const moduleSkill = join(moduleBaseDir, "skill", "SKILL.md");
		mkdirSync(join(moduleBaseDir, "skill"), { recursive: true });
		writeFileSync(moduleSkill, "---\nname: gpt-image-gen\ndescription: module copy\n---\nmodule body\n");
		const factory: ExtensionFactory = (pi) =>
			registerImageGenExtension(pi, moduleBaseDir, { shippedSkillDir: sidecarDir });
		const { cwd, runner } = await createRunner(factory);

		const resources = await runner.emitResourcesDiscover(cwd, "startup");
		const paths = resources.skillPaths.map((entry) => entry.path);

		expect(paths).toEqual([moduleSkill]);
	});

	it("omits the skill and reports both probe locations once when nothing real ships", async () => {
		vi.resetModules();
		const fresh = await import("../../../src/core/extensions/builtin/imagegen/index.ts");
		setImageGenRegistry(stubRegistry(true));
		const { sidecarDir } = stageSidecarSkill();
		const missingBaseDir = createTempDir("senpi-3799-nothing-real");
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const first = await fresh.bundledSkillPath(missingBaseDir, { shippedSkillDir: join(sidecarDir, "absent") });
			const second = await fresh.bundledSkillPath(missingBaseDir, { shippedSkillDir: join(sidecarDir, "absent") });

			expect(first).toBeUndefined();
			expect(second).toBeUndefined();
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(debugSpy).not.toHaveBeenCalled();
			expect(logSpy).not.toHaveBeenCalled();
			// The notice names BOTH probed locations: a compiled binary never has the module-relative
			// asset, so the sidecar path is the actionable one for the operator who has to stage it.
			const notice = String(errorSpy.mock.calls[0]?.[0] ?? "");
			expect(notice).toContain(join(missingBaseDir, "skill", "SKILL.md"));
			expect(notice).toContain(join(join(sidecarDir, "absent"), "SKILL.md"));
		} finally {
			debugSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("recognizes every Bun locator spelling a compiled binary can hand back", async () => {
		const { isBunVirtualPath } = await import("../../../src/config.ts");

		expect(isBunVirtualPath("/$bunfs/root/SKILL-8gt84szq.md")).toBe(true);
		expect(isBunVirtualPath("/$bunfs/skill/bun-1-4/SKILL.md")).toBe(true);
		expect(isBunVirtualPath("B:\\~BUN\\root\\SKILL-8gt84szq.md")).toBe(true);
		expect(isBunVirtualPath("/%7EBUN/root/SKILL-8gt84szq.md")).toBe(true);
		expect(isBunVirtualPath("/home/user/.skills/SKILL.md")).toBe(false);
		expect(isBunVirtualPath("C:\\Users\\user\\skills\\SKILL.md")).toBe(false);
	});
});
