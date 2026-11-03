// senpi#5413 (RT10-pre, brain/hand split): the built-in tools run on a runtime that owns no session, and a session's
// built-in tools are unchanged. Guards the F01 core-registry surface for a session-less runtime and, as a Z1 pin, the
// session-bound `read` (model-specific image note) and `bash` (session environment) outputs.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { bootstrapRuntime, buildToolRegistry } from "../../src/core/runtime/bootstrap.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createToolDispatcher } from "../../src/core/tool-dispatch/tool-dispatcher.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const NON_VISION_NOTE = "[Current model does not support images. The image will be omitted from this request.]";
const SESSION_ENV = `printf '%s|%s|%s' "\${PI_SESSION_ID-unset}" "\${PI_PROVIDER-unset}" "\${PI_MODEL-unset}"`;

type Execute = (name: string, params: Record<string, unknown>) => Promise<{ content: unknown[] }>;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-rt10-pre-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "note.txt"), "plain text\n");
	writeFileSync(join(dir, "pixel.png"), Buffer.from(PIXEL_PNG, "base64"));
	return dir;
}

function texts(result: { content: unknown[] }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => Reflect.get(Object(part), "type") === "text")
		.map((part) => part.text)
		.join("");
}

async function sessionlessExecute(cwd: string): Promise<Execute> {
	const dispatcher = createToolDispatcher({ runtime: "in-process" });
	cleanups.push(() => void dispatcher.dispose());
	const runtime = bootstrapRuntime({
		cwd,
		settingsManager: SettingsManager.inMemory(),
		extensionsResult: await createTestExtensionsResult([], cwd),
		modelRegistry: await createInMemoryModelRegistry(AuthStorage.inMemory()),
		toolDispatcher: dispatcher,
	});
	const registry = buildToolRegistry({
		baseToolDefinitions: runtime.baseToolDefinitions,
		runner: runtime.extensionRunner,
		dispatcher,
	});
	return async (name, params) => {
		const tool = registry.toolRegistry.get(name);
		if (tool === undefined) throw new Error(`no ${name} tool`);
		return tool.execute(`call-${name}`, params, undefined, undefined);
	};
}

async function textOnlySession(cwd: string): Promise<{ harness: Harness; execute: Execute }> {
	const harness = await createHarness({ cwd, models: [{ id: "text-only", input: ["text"] }] });
	cleanups.push(() => harness.cleanup());
	return {
		harness,
		execute: async (name, params) => {
			const tool = harness.session.getRegisteredTool(name);
			if (tool === undefined) throw new Error(`no ${name} tool`);
			return tool.execute(`call-${name}`, params, undefined, undefined);
		},
	};
}

describe("built-in tools on a runtime without a session (senpi#5413)", () => {
	it("reads a text file", async () => {
		const cwd = scratchDir();
		const execute = await sessionlessExecute(cwd);

		const result = await execute("read", { path: "note.txt" });

		expect(texts(result)).toContain("plain text");
	});

	it("reads an image with no model-specific note", async () => {
		const cwd = scratchDir();
		const execute = await sessionlessExecute(cwd);

		const result = await execute("read", { path: "pixel.png" });

		expect(texts(result)).not.toContain(NON_VISION_NOTE);
		expect(result.content.some((part) => Reflect.get(Object(part), "type") === "image")).toBe(true);
	});

	it("runs bash with no session environment", async () => {
		const cwd = scratchDir();
		const execute = await sessionlessExecute(cwd);

		const result = await execute("bash", { command: SESSION_ENV });

		expect(texts(result).trim()).toBe("unset|unset|unset");
	});
});

describe("built-in tools in a session stay as they are (senpi#5413, Z1)", () => {
	it("read notes that a text-only model cannot see the image", async () => {
		const cwd = scratchDir();
		const { execute } = await textOnlySession(cwd);

		const result = await execute("read", { path: join(cwd, "pixel.png") });

		expect(texts(result)).toContain(NON_VISION_NOTE);
	});

	it("bash exposes the session's id, provider and model", async () => {
		const cwd = scratchDir();
		const { harness, execute } = await textOnlySession(cwd);

		const result = await execute("bash", { command: SESSION_ENV });

		const model = harness.getModel();
		expect(texts(result).trim()).toBe(`${harness.session.sessionId}|${model.provider}|${model.id}`);
	});
});
