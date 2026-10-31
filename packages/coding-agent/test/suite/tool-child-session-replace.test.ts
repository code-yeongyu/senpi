// senpi#3566 todo 4 (review MEDIUM at 104ed62f99): replacing a session (new, switch, fork, resume) waits for the
// replaced session's tool child to stop, so by the time the replacement settles that child and every command it
// launched are gone - the same guarantee as closing the session.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";

const EXTENSION = `import { Type } from "typebox";
export default function (pi) {
	pi.registerTool({
		name: "child_sleeper",
		label: "child sleeper",
		description: "starts a long command from the tool child",
		placement: "child",
		childModule: { path: "./body.ts", export: "sleeper" },
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "in-process" }], details: {} }),
	});
}
`;

const BODY = `import { spawn } from "node:child_process";
export function sleeper() {
	const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
	child.unref();
	return { content: [{ type: "text", text: "started" }], details: { sleepPid: child.pid, childPid: process.pid } };
}
`;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("replacing a session under the child tool runtime", () => {
	it("ends the replaced session's tool child and its commands before its replacement is built", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tc-replace-"));
		const extensionDir = join(dir, "ext");
		mkdirSync(extensionDir);
		writeFileSync(join(extensionDir, "index.ts"), EXTENSION);
		writeFileSync(join(extensionDir, "body.ts"), BODY);
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		// Whether the replaced session's commands were still alive at the moment its replacement started being built.
		let atReplacement: boolean[] | undefined;
		let watched: { sleepPid: number; childPid: number } | undefined;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			if (watched !== undefined) atReplacement = [alive(watched.sleepPid), alive(watched.childPid)];
			const services = await createAgentSessionServices({
				agentDir: join(dir, "agent"),
				cwd,
				resourceLoaderOptions: {
					additionalExtensionPaths: [join(extensionDir, "index.ts")],
					extensionFactories: [
						(pi: ExtensionAPI) => {
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
						},
					],
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
					toolRuntime: "child",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: dir,
			agentDir: join(dir, "agent"),
			sessionManager: SessionManager.inMemory(dir),
		});
		try {
			await runtime.session.bindExtensions({});
			const result = await runtime.session.executeTool("child_sleeper", {});
			watched = result.details as { sleepPid: number; childPid: number };
			expect([alive(watched.sleepPid), alive(watched.childPid)]).toEqual([true, true]);
			await runtime.newSession();
			expect(atReplacement).toEqual([false, false]);
		} finally {
			await runtime.dispose();
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
