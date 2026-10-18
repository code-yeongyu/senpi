import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionHeldError } from "../../../src/core/session-holders.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { rebindSessionFile } from "../../../src/core/session-rebind.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { cleanupIssue2184, isolateAgentDir, tempDir } from "./issue-2184-support.ts";

// Issue #2184: the session a runtime has open is held against moves by other processes for exactly
// as long as the runtime keeps it open.

const cleanups: Array<() => Promise<void>> = [];

beforeEach(isolateAgentDir);
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	cleanupIssue2184();
});

async function runtimeIn(cwd: string) {
	const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	const registerFaux = (pi: ExtensionAPI) => {
		pi.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		});
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: cwd,
			resourceLoaderOptions: {
				extensionFactories: [registerFaux],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.create(cwd),
	});
	await runtime.session.bindExtensions({});
	cleanups.push(async () => {
		await runtime.dispose();
		faux.unregister();
	});
	return runtime;
}

describe("issue #2184 a runtime holds the session it has open", () => {
	it("blocks a move of its session until it switches away, then allows it", async () => {
		const root = tempDir();
		const cwd = join(root, "repo");
		const elsewhere = join(root, "moved");
		mkdirSync(cwd, { recursive: true });
		const runtime = await runtimeIn(cwd);
		await runtime.session.prompt("hello");
		const sessionFile = runtime.session.sessionFile;
		if (sessionFile === undefined) throw new Error("expected a persisted session file");

		const held = await rebindSessionFile(sessionFile, elsewhere).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(held).toBeInstanceOf(SessionHeldError);
		expect((held as SessionHeldError).holders).toEqual([{ pid: process.pid, cwd }]);

		await runtime.newSession();

		const target = await rebindSessionFile(sessionFile, elsewhere);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(sessionFile)).toBe(false);
	});

	it("releases its session when disposed", async () => {
		const root = tempDir();
		const cwd = join(root, "repo");
		mkdirSync(cwd, { recursive: true });
		const runtime = await runtimeIn(cwd);
		await runtime.session.prompt("hello");
		const sessionFile = runtime.session.sessionFile;
		if (sessionFile === undefined) throw new Error("expected a persisted session file");

		await cleanups.pop()?.();

		await expect(rebindSessionFile(sessionFile, join(root, "moved"))).resolves.toContain("moved");
	});
});
