import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createAgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ProjectTrustContext } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";

// PR #1473 gdAkN: exercise the CLI's real trust/resource/factory wiring, not a trust mock.
it.each([true, false])(
	"PR1473 gdAkN: destination trust and factories respect veto (cancel=%s)",
	async (cancel) => {
		const root = mkdtempSync(join(tmpdir(), "pr1473-trust-"));
		const cwd = join(root, "source");
		const destination = join(root, "destination");
		const agentDir = join(root, "agent");
		const extensions = join(destination, ".senpi", "extensions");
		for (const dir of [cwd, agentDir, extensions]) mkdirSync(dir, { recursive: true });
		const marker = join(destination, "factory-ran");
		const fauxModule = fileURLToPath(new URL("../../../../ai/src/providers/faux.ts", import.meta.url));
		writeFileSync(
			join(extensions, "destination.js"),
			`import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxModule)};
export default function(pi) {
 appendFileSync(${JSON.stringify(marker)}, "factory\\n");
 const faux = fauxProvider({ provider: "pr1473-destination", models: [{ id: "destination-model" }] });
 faux.setResponses([
  fauxAssistantMessage(fauxToolCall("destination_tool", {}, { id: "destination-call" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("DESTINATION_PROVIDER_OK")
 ]);
 pi.registerProvider(faux.provider);
 pi.registerTool({ name: "destination_tool", label: "Destination", description: "Return destination sentinel",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async () => ({ content: [{ type: "text", text: "DESTINATION_TOOL_OK" }], details: {} }) });
}`,
		);
		writeFileSync(
			join(destination, ".senpi", "settings.json"),
			JSON.stringify({ defaultProvider: "pr1473-destination", defaultModel: "destination-model" }),
		);
		const faux = fauxProvider({ provider: "pr1473-source", models: [{ id: "source-model" }] });
		faux.setResponses([fauxAssistantMessage("SOURCE_OK"), fauxAssistantMessage("SOURCE_FOLLOWUP")]);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "pr1473-source", defaultModel: "source-model" }),
		);
		let factories = 0;
		const events: string[] = [];
		const factory = createCliRuntimeFactory(
			{
				cwd,
				agentDir,
				appMode: "interactive",
				parsed: parseArgs(["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]),
			},
			{
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
						pi.on("session_before_switch", () => {
							events.push("veto");
							return { cancel };
						});
						pi.on("session_shutdown", () => {
							events.push("shutdown");
						});
					},
				],
			},
		);
		const runtime = await createAgentSessionRuntime(
			async (options) => {
				factories++;
				return factory(options);
			},
			{ cwd, agentDir, sessionManager: SessionManager.create(cwd, join(root, "sessions")) },
		);
		let prompts = 0;
		let contexts = 0;
		const trustContext = (targetCwd: string): ProjectTrustContext => {
			contexts++;
			return {
				cwd: targetCwd,
				mode: "tui",
				hasUI: true,
				ui: {
					select: async (_title, options) => {
						prompts++;
						return options[0];
					},
					confirm: async () => false,
					input: async () => undefined,
					notify: () => {},
				},
			};
		};
		try {
			await runtime.session.bindExtensions({});
			runtime.setRebindSession(async (session) => {
				await session.bindExtensions({});
			});
			expect(runtime.diagnostics.filter((entry) => entry.type === "error")).toEqual([]);
			await runtime.session.prompt("persist source", { sessionTitlePrompt: false });
			const live = runtime.session;
			const parent = live.sessionFile;
			if (!parent) throw new Error("Missing source file");
			const parentBytes = readFileSync(parent);
			const target = SessionManager.create(destination, join(root, "targets"));
			target.newSession({ parentSession: parent });
			target.appendMessage({ role: "user", content: "destination history", timestamp: 0 });
			target.appendMessage({
				...fauxAssistantMessage("stored"),
				provider: "pr1473-destination",
				model: "destination-model",
			});
			const path = target.getSessionFile();
			if (!path) throw new Error("Missing destination file");
			const bytes = readFileSync(path);
			expect(await runtime.switchSession(path, { projectTrustContextFactory: trustContext })).toEqual({
				cancelled: cancel,
			});
			if (cancel) {
				expect.soft(prompts).toBe(0);
				expect.soft(contexts).toBe(0);
				expect.soft(factories).toBe(1);
				expect.soft(existsSync(marker)).toBe(false);
				expect.soft(existsSync(join(agentDir, "trust.json"))).toBe(false);
				expect.soft(new ProjectTrustStore(agentDir).get(destination)).toBe(null);
				expect(events).toEqual(["veto"]);
				expect(readFileSync(path)).toEqual(bytes);
				expect(runtime.session).toBe(live);
				await live.prompt("still here", { sessionTitlePrompt: false });
				expect(live.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "SOURCE_FOLLOWUP" }] });
			} else {
				expect(prompts).toBe(1);
				expect(contexts).toBe(1);
				expect(factories).toBe(2);
				expect(readFileSync(marker, "utf8")).toBe("factory\n");
				expect(new ProjectTrustStore(agentDir).get(destination)).toBe(true);
				expect(events).toEqual(["veto", "shutdown"]);
				expect(runtime.session.model).toMatchObject({ provider: "pr1473-destination", id: "destination-model" });
				expect(runtime.session.getActiveToolNames()).toContain("destination_tool");
				expect(runtime.diagnostics.filter((entry) => entry.type === "error")).toEqual([]);
				await runtime.session.prompt("use destination tool", { sessionTitlePrompt: false });
				expect(runtime.session.messages).toContainEqual(
					expect.objectContaining({
						role: "toolResult",
						toolName: "destination_tool",
						isError: false,
						content: [{ type: "text", text: "DESTINATION_TOOL_OK" }],
					}),
				);
				expect(runtime.session.messages.at(-1)).toMatchObject({
					content: [{ type: "text", text: "DESTINATION_PROVIDER_OK" }],
				});
				expect(readFileSync(parent)).toEqual(parentBytes);
			}
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	},
	60_000,
);
