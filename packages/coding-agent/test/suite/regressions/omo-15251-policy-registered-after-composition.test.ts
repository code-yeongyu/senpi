import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../../../scripts/vitest-temp.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ExtensionAPI, FilesystemPolicyRegistration } from "../../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { model } from "../recommended-models-harness.ts";

// omo#15251: the built-in tools compose filesystem policies when the session's runtime is built. A policy registered
// later (the memory guard registered on session_start) was recorded and reported but never consulted. It is now
// refused loudly; one registered while the extension loads applies. Synthetic paths only.
async function sessionWith(register: "factory" | "session_start" | "none") {
	const root = realpathSync(makeTempDir(join(tmpdir(), "omo-15251-")));
	const guarded = join(root, "guarded");
	mkdirSync(guarded, { recursive: true });
	writeFileSync(join(guarded, "note.md"), "synthetic guarded line\n");
	const registrations: FilesystemPolicyRegistration[] = [];
	const policy = {
		check: ({ canonicalPath }: { canonicalPath: string }) =>
			canonicalPath.startsWith(guarded)
				? { allow: false as const, reason: "synthetic: guarded" }
				: { allow: true as const },
	};
	const factory = (pi: ExtensionAPI) => {
		if (register === "none") return;
		if (register === "factory") registrations.push(pi.registerFilesystemPolicy(policy));
		else pi.on("session_start", () => void registrations.push(pi.registerFilesystemPolicy(policy)));
	};
	const faux = model("composition-model");
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(faux.provider, {
		baseUrl: faux.baseUrl,
		api: faux.api,
		models: [
			{
				id: faux.id,
				name: faux.name,
				api: faux.api,
				reasoning: faux.reasoning,
				input: faux.input,
				cost: faux.cost,
				contextWindow: faux.contextWindow,
				maxTokens: faux.maxTokens,
			},
		],
	});
	const settingsManager = SettingsManager.inMemory({ defaultProvider: faux.provider, defaultModel: faux.id });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		extensionFactories: [{ factory, path: "<inline:omo-15251>" }] as never,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(root),
		resourceLoader,
	});
	await session.bindExtensions({});
	const read = session.getRegisteredTool("read");
	if (!read) throw new Error("no read tool");
	const outcome = await read.execute("read-guarded", { path: join(guarded, "note.md") } as never).then(
		() => "ran",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	session.dispose();
	return { registrations, outcome };
}

describe("a filesystem policy registered after the tools composed their policies (omo#15251)", () => {
	it("applies a policy registered while the extension loads", async () => {
		const { registrations, outcome } = await sessionWith("factory");

		expect(registrations).toEqual([{ applied: true, entryPruning: true }]);
		expect(outcome).toBe("synthetic: guarded");
	});

	it("refuses one registered on session_start, with a warning, instead of reporting a policy no tool consults", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { registrations, outcome } = await sessionWith("session_start");

		expect(registrations).toEqual([{ applied: false, reason: expect.stringContaining("would never apply") }]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("registered a filesystem policy after"));
		expect(outcome).toBe("ran");
		warn.mockRestore();
	});

	it("no built-in extension registers a policy after composition", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await sessionWith("none");

		expect(warn.mock.calls.filter(([line]) => String(line).includes("registered a filesystem policy after"))).toEqual(
			[],
		);
		warn.mockRestore();
	});
});
