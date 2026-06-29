import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { type BuiltinExtensionFactory, builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const createdDirs: string[] = [];
const T13_FORBIDDEN_ADAPTER_EVENTS = ["agent_end"] as const;

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);
	return dir;
}

function getBuiltinExtension(id: string): BuiltinExtensionFactory {
	const extension = builtinExtensions.find((entry) => entry.id === id);
	if (extension === undefined) {
		throw new Error(`missing builtin extension: ${id}`);
	}
	return extension;
}

describe("builtin hooks extension registration and resource plumbing", () => {
	it("registers hooks before the permission system builtin", () => {
		// Given
		const ids = builtinExtensions.map((extension) => extension.id);

		// When
		const hooksIndex = ids.indexOf("hooks");
		const permissionIndex = ids.indexOf("permission-system");

		// Then
		expect(hooksIndex).toBeGreaterThanOrEqual(0);
		expect(permissionIndex).toBeGreaterThanOrEqual(0);
		expect(hooksIndex).toBeLessThan(permissionIndex);
	});

	it("registers the T11 prompt, T12 tool, and T13 lifecycle adapter runtime handlers only", async () => {
		// Given
		const cwd = createTempDir("senpi-hooks-t10-registration-cwd");
		const hooksExtension = getBuiltinExtension("hooks");

		// When
		const extensionsResult = await createTestExtensionsResult(
			[{ factory: hooksExtension.factory, path: "<builtin:hooks>" }],
			cwd,
		);
		const loadedHooksExtension = extensionsResult.extensions.find(
			(extension) => extension.path === "<builtin:hooks>",
		);
		if (loadedHooksExtension === undefined) {
			throw new Error("builtin hooks extension did not load");
		}
		const registeredEvents = new Set(loadedHooksExtension.handlers.keys());

		// Then
		expect(loadedHooksExtension.commands.has("hooks")).toBe(true);
		expect(registeredEvents.has("input")).toBe(true);
		expect(registeredEvents.has("before_agent_start")).toBe(true);
		expect(registeredEvents.has("tool_call")).toBe(true);
		expect(registeredEvents.has("tool_result")).toBe(true);
		expect(registeredEvents.has("session_start")).toBe(true);
		expect(registeredEvents.has("session_before_compact")).toBe(true);
		expect(registeredEvents.has("session_compact")).toBe(true);
		for (const event of T13_FORBIDDEN_ADAPTER_EVENTS) {
			expect(registeredEvents.has(event)).toBe(false);
		}
		expect(Array.from(registeredEvents).sort()).toEqual([
			"before_agent_start",
			"input",
			"session_before_compact",
			"session_compact",
			"session_start",
			"tool_call",
			"tool_result",
		]);
	});

	it("collects resource-discovered hook paths as runtime hook sources", async () => {
		// Given
		const cwd = createTempDir("senpi-hooks-runtime-cwd");
		const hookPath = join(cwd, "runtime-hooks.json");
		const extensionFactory: ExtensionFactory = (pi) => {
			pi.on("resources_discover", () => ({ hookPaths: [hookPath] }));
		};
		const extensionsResult = await createTestExtensionsResult(
			[{ factory: extensionFactory, path: "/tmp/hooks-ext.ts" }],
			cwd,
		);
		const runner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			SessionManager.inMemory(),
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);

		// When
		const result = await runner.emitResourcesDiscover(cwd, "reload");

		// Then
		expect(result.hookPaths).toEqual([{ path: hookPath, extensionPath: "/tmp/hooks-ext.ts" }]);
	});

	it("stores pre-session and runtime hook sources for extension context reads", async () => {
		// Given
		const cwd = createTempDir("senpi-hooks-loader-cwd");
		const agentDir = join(cwd, "agent");
		const preSessionHookPath = join(cwd, "pre-session-hooks.json");
		const runtimeHookPath = join(cwd, "runtime-hooks.json");
		mkdirSync(agentDir, { recursive: true });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalHookPaths: [preSessionHookPath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await loader.reload();

		// When
		loader.extendResources({
			hookPaths: [
				{
					path: runtimeHookPath,
					metadata: { source: "extension:test", scope: "temporary", origin: "top-level" },
				},
			],
		});

		// Then
		expect(loader.getLoadedHookSources()).toMatchObject({
			agentDir: resolve(agentDir),
			cwd: resolve(cwd),
			globalHooksPath: join(resolve(agentDir), "hooks.json"),
			projectHooksPath: join(resolve(cwd), ".senpi", "hooks.json"),
			preSessionHookSourcePaths: [resolve(preSessionHookPath)],
			runtimeHookSourcePaths: [resolve(runtimeHookPath)],
		});
	});

	it("keeps malformed hook source diagnostics nonfatal during no-op startup", async () => {
		// Given
		const cwd = createTempDir("senpi-hooks-malformed-cwd");
		const agentDir = join(cwd, "agent");
		const malformedPath = join(cwd, "bad-hooks.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(malformedPath, "{ bad json", "utf-8");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalHookPaths: [malformedPath],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		// When
		await expect(loader.reload()).resolves.toBeUndefined();
		const extensionsResult = loader.getExtensions();

		// Then
		expect(extensionsResult.errors).not.toContainEqual(expect.objectContaining({ path: "<builtin:hooks>" }));
		expect(extensionsResult.extensions.some((extension) => extension.path === "<builtin:hooks>")).toBe(true);
	});
});
