import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import * as sessionHolders from "../../../src/core/session-holders.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { reservationPhase } from "../rpc-worker-reservation-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

// senpi#2951: exercise command-context -> controller -> real runtime replacement, with a virtual terminal.
it.each(["holder", "lookup-error"] as const)("resumes through the public controller and warns for %s", async (kind) => {
	const root = await mkdtemp(join(tmpdir(), "held-resume-public-"));
	const target = join(root, "target.jsonl");
	const id = randomUUID();
	await writeFile(
		target,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
	const faux = registerFauxProvider({ models: [{ id: "faux-resume", reasoning: false }] });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: root,
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
						pi.registerCommand("fixture-resume", {
							handler: async (_args, ctx) => {
								const result = await ctx.switchSession(target);
								expect(result.cancelled).toBe(false);
							},
						});
					},
				],
			},
		});
		services.settingsManager.applyOverrides({ quietStartup: true });
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
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(root),
	});
	initTheme("dark");
	const terminal = new VirtualTerminal(180, 40);
	const mode = new InteractiveMode(runtime, { terminal, initialThemeSetting: "dark" });
	const printed = Promise.withResolvers<void>();
	let needle = "";
	const originalWrite = terminal.write.bind(terminal);
	const output: string[] = [];
	vi.spyOn(terminal, "write").mockImplementation((data) => {
		originalWrite(data);
		const text = stripVTControlCharacters(data);
		output.push(text);
		if (needle && text.includes(needle)) printed.resolve();
	});
	try {
		await using holder = kind === "holder" ? await startSessionHolder(target, id, root) : undefined;
		await mode.init();
		if (kind === "lookup-error")
			vi.spyOn(sessionHolders, "liveSessionHolders").mockRejectedValueOnce(new Error("ENOTDIR"));
		needle = holder ? String(holder.pid) : "Unable to inspect session holders";
		await runtime.session.prompt("/fixture-resume");
		expect(runtime.session.sessionManager.getSessionId()).toBe(id);
		await reservationPhase("resume-warning-rendered", printed.promise);
		if (holder) expect(output.join("\n")).toContain(root);
	} finally {
		mode.stop();
		await runtime.dispose();
		vi.restoreAllMocks();
		faux.unregister();
		await rm(root, { recursive: true, force: true });
	}
});
