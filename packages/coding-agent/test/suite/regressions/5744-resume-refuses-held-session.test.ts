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
import { foreignSessionHolders } from "../../../src/core/foreign-session-holders.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { reservationStep } from "../rpc-worker-reservation-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

// senpi#5744: /resume of a session another live process holds switched onto it and only warned. The restored
// lifecycle then read the other process's live run as "interrupted · type to continue", so the next input
// started a second run of the same session. A resume of a held session now asks: Cancel, or take over (the holder
// is asked to exit first). Either way there is never a second writer.
const TAKE_OVER = "Take over (stop it there)";

it.each(["Cancel", TAKE_OVER] as const)("a resume of a session another live process holds: %s", async (choice) => {
	const root = await mkdtemp(join(tmpdir(), "held-resume-refused-"));
	const target = join(root, "target.jsonl");
	const id = randomUUID();
	await writeFile(
		target,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
	const faux = registerFauxProvider({ models: [{ id: "faux-resume", reasoning: false }] });
	const resumed = Promise.withResolvers<{ cancelled: boolean }>();
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
								resumed.resolve(await ctx.switchSession(target));
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
	const before = runtime.session.sessionManager.getSessionId();
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
		await using holder = await startSessionHolder(target, id, root);
		await mode.init();
		const asked: string[] = [];
		vi.spyOn(
			InteractiveMode.prototype as unknown as { showExtensionSelector: (title: string) => Promise<string> },
			"showExtensionSelector",
		).mockImplementation(async (title) => {
			asked.push(title);
			return choice;
		});
		if (choice === "Cancel") needle = "Not resumed";
		await runtime.session.prompt("/fixture-resume");
		const result = await reservationStep("held-resume-settled", resumed.promise);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain(`pid ${holder.pid}`);
		if (choice === "Cancel") {
			expect(result).toEqual({ cancelled: true });
			expect(runtime.session.sessionManager.getSessionId()).toBe(before);
			await reservationStep("held-resume-refusal-rendered", printed.promise);
		} else {
			expect(result).toEqual({ cancelled: false });
			expect(runtime.session.sessionManager.getSessionId()).toBe(id);
			expect(await foreignSessionHolders(target, id)).toEqual([]);
		}
	} finally {
		mode.stop();
		await runtime.dispose();
		vi.restoreAllMocks();
		faux.unregister();
		await rm(root, { recursive: true, force: true });
	}
});
