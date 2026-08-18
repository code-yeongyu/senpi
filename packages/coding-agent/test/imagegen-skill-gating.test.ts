import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ImageGenAuthRegistry } from "../src/core/extensions/builtin/imagegen/auth.ts";
import { IMAGE_GEN_SECTION, registerImageGenExtension } from "../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry } from "../src/core/extensions/builtin/imagegen/state.ts";
import { builtinExtensions } from "../src/core/extensions/builtin/index.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { loadSkills } from "../src/core/skills.ts";
import { createTestExtensionsResult } from "./utilities.ts";

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

function imageGenBuiltinFactory(): ExtensionFactory {
	const builtin = builtinExtensions.find((extension) => extension.id === "imagegen");
	if (builtin === undefined) throw new Error("imagegen builtin is not registered");
	return builtin.factory;
}

async function createRunner(factory: ExtensionFactory) {
	const cwd = createTempDir("senpi-imagegen-skill");
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

afterEach(() => {
	setImageGenRegistry(undefined);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const path of createdDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("imagegen skill contribution", () => {
	it("contributes and loads gpt-image-gen when credentials exist", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		setImageGenRegistry(stubRegistry(true));
		const { cwd, runner } = await createRunner(imageGenBuiltinFactory());

		const resources = await runner.emitResourcesDiscover(cwd, "startup");
		const skillPaths = resources.skillPaths.map((entry) => entry.path);
		const loaded = loadSkills({ cwd, agentDir: join(cwd, "agent"), skillPaths, includeDefaults: false });
		const prompt = await runner.emitBeforeAgentStart("draw an image", undefined, "base", { cwd });

		expect(skillPaths).toHaveLength(1);
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.skills.map((skill) => skill.name)).toContain("gpt-image-gen");
		expect(prompt?.systemPrompt).toBe(`base\n${IMAGE_GEN_SECTION}`);
	});

	it("contributes no skill or section when credentials are absent", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		setImageGenRegistry(stubRegistry(false));
		const { cwd, runner } = await createRunner(imageGenBuiltinFactory());

		const resources = await runner.emitResourcesDiscover(cwd, "startup");
		const prompt = await runner.emitBeforeAgentStart("draw an image", undefined, "base", { cwd });

		expect(resources.skillPaths).toEqual([]);
		expect(prompt).toBeUndefined();
	});

	it("omits a missing skill path without crashing", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
		setImageGenRegistry(stubRegistry(true));
		const missingBaseDir = createTempDir("senpi-imagegen-missing-skill");
		const factory: ExtensionFactory = (pi) => registerImageGenExtension(pi, missingBaseDir);
		const { cwd, runner } = await createRunner(factory);
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

		const resources = await runner.emitResourcesDiscover(cwd, "reload");
		await runner.emitResourcesDiscover(cwd, "reload");

		expect(resources.skillPaths).toEqual([]);
		expect(errors).toEqual([]);
		expect(debug).toHaveBeenCalledTimes(1);
	});
});
