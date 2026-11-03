import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { ModelUsabilityBudgetError } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// #1473: #1517/#1538 admit compactable history, but disabled compaction still rejects.
it("keeps the outgoing session usable when resume admission rejects with compaction disabled", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
	const cwd = mkdtempSync(join(tmpdir(), "pr1473-rejected-live-"));
	const faux = registerFauxProvider({
		models: [{ id: "resume", contextWindow: 100_000, maxTokens: 4_000 }],
	});
	faux.setResponses([fauxAssistantMessage("SOURCE_READY"), fauxAssistantMessage("SOURCE_SURVIVED")]);
	let shutdowns = 0;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models,
						});
						pi.on("session_shutdown", () => {
							shutdowns++;
						});
					},
				],
			},
		});
		services.settingsManager.applyOverrides({ compaction: { enabled: false } });
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
		sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
	});
	try {
		await runtime.session.bindExtensions({});
		await runtime.session.prompt("persist source", { sessionTitlePrompt: false });
		const live = runtime.session;
		const target = SessionManager.create(cwd, join(cwd, "targets"));
		target.appendMessage({ role: "user", content: "restored context ".repeat(40_000), timestamp: 1 });
		target.appendMessage(fauxAssistantMessage("stored", { timestamp: 2 }));
		const path = target.getSessionFile();
		if (!path) throw new Error("Missing persisted destination");
		const before = readFileSync(path);

		await expect(runtime.switchSession(path)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		expect.soft(runtime.session).toBe(live);
		expect.soft(readFileSync(path)).toEqual(before);
		expect.soft(shutdowns).toBe(0);
		await expect(live.prompt("continue source", { sessionTitlePrompt: false })).resolves.toBeUndefined();
		expect(live.messages.at(-1)).toMatchObject({
			content: [{ type: "text", text: "SOURCE_SURVIVED" }],
		});
		const sourcePath = live.sessionFile;
		if (!sourcePath) throw new Error("Missing persisted source");
		expect(SessionManager.open(sourcePath).buildSessionContext().messages).toEqual(live.messages);
	} finally {
		await runtime.dispose();
		faux.unregister();
		vi.useRealTimers();
		rmSync(cwd, { recursive: true, force: true });
	}
}, 30_000);
