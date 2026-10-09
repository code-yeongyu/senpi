import { bindToProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
	SessionStartEvent,
} from "../../types.ts";
import { installMcpNativeToolSearchGate } from "../tool-search/native-search.ts";
import { registerMcpCommands } from "./commands.ts";
import {
	isMcpControlInventoryRequest,
	MCP_CONTROL_INVENTORY_CHANGED_EVENT,
	MCP_CONTROL_INVENTORY_REQUEST_EVENT,
} from "./control-inventory.ts";
import { injectMcpInstructions, refreshMcpInstructionsForSession } from "./instructions.ts";
import { createMcpLogger } from "./log.ts";
import { registerMcpPromptCommands } from "./prompts.ts";
import { expandMcpResourceMentions } from "./resources.ts";
import { getMcpService, McpService } from "./service.ts";
import {
	parseSkillMcpDeclarations,
	type SkillLike,
	type SkillMcpDeclarations,
	skillActivationTargets,
} from "./skills.ts";
import { reportMcpAsyncError, safeEventBusOn, wrapAsync } from "./wrap.ts";

const MCP_BUILTIN_EXTENSION_PATH = "<builtin:mcp>";

export function createMcpExtension(service: McpService, sessionOwned = true): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		let attachPromise: Promise<void> | undefined;
		let attachedSessionId: string | undefined;
		let controlInventoryDisposed = false;
		const unsubscribeControlInventoryRequest = safeEventBusOn(
			pi.events,
			MCP_CONTROL_INVENTORY_REQUEST_EVENT,
			(data) => {
				if (!isMcpControlInventoryRequest(data) || data.sessionId !== attachedSessionId) return;
				data.respond(service.refreshWireStatusSnapshot(data.sessionId));
			},
		);
		const unsubscribeWireStatus = service.onWireStatusChanged((sessionId, snapshot) => {
			if (sessionId === undefined || sessionId !== attachedSessionId) return;
			pi.events.emit(MCP_CONTROL_INVENTORY_CHANGED_EVENT, { sessionId, snapshot });
		});
		const disposeControlInventory = (): void => {
			if (controlInventoryDisposed) return;
			controlInventoryDisposed = true;
			unsubscribeControlInventoryRequest();
			unsubscribeWireStatus();
		};
		const sink = {
			logger: {
				error(message: string, data?: unknown): void {
					createMcpLogger("service").error(message, data);
				},
			},
		};

		registerMcpCommands(pi, service, () => attachPromise);

		installMcpNativeToolSearchGate(() => {
			const setting = service.getNativeToolSearchSetting();
			return setting === true || setting === "auto";
		});
		// skills-carry-MCP (todo 37): skills declaring MCP servers (mcp.json
		// sidecar or SKILL.md frontmatter) register lazily with tools hidden;
		// loading a skill — /skill:<name> input or the model reading its SKILL.md —
		// reveals that skill's includeTools matches for the rest of the session.
		let skillDecls: SkillMcpDeclarations = { servers: new Map(), warnings: [] };
		let skillsByName = new Map<string, SkillLike>();
		const loadedSkills = new Set<string>();
		const revealSkill = (skillName: string): void => {
			if (loadedSkills.has(skillName) || !skillsByName.has(skillName)) return;
			loadedSkills.add(skillName);
			const registered = service.getTierBSearchable(pi);
			const targets = skillActivationTargets(skillDecls, skillName, registered);
			if (targets.length > 0) service.activateSkillMcpTools(targets, pi);
		};
		pi.on("input", async (event, ctx) => {
			const match = /^\s*\/skill:([A-Za-z0-9._-]+)/.exec(event.text);
			if (match) revealSkill(match[1]);
			// @mcp:<server>/<uri> mention expansion (todo 39): recognized mentions are
			// inlined via the sanctioned input transform; failures pass through
			// untouched with a one-line notice so submission is never blocked.
			if (event.text.includes("@mcp:")) {
				const expansion = await expandMcpResourceMentions(event.text, () => service.getMcpResourceServers(pi));
				for (const notice of expansion.notices) {
					createMcpLogger("resources").warn(notice);
					void ctx.ui?.notify?.(notice, "warning");
				}
				if (expansion.changed) return { action: "transform", text: expansion.text };
			}
			return undefined;
		});
		pi.on("tool_call", (event) => {
			if (event.toolName !== "read") return undefined;
			const path = (event.input as { path?: string }).path;
			if (path === undefined) return undefined;
			for (const [name, skill] of skillsByName) {
				if (path === skill.filePath || path.endsWith(skill.filePath)) revealSkill(name);
			}
			return undefined;
		});

		// Attach is single-flight: the prompt uses the original attach's bindings
		// and known catalog, without waiting for deferred remote discovery.
		// session_start always starts a fresh attach (reloads must re-sync config).
		const attach = (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
			attachedSessionId = ctx.sessionManager?.getSessionId?.();
			attachPromise = (async () => {
				await service.attachSession(event, ctx, pi);
				refreshMcpInstructionsForSession(service);
				if (sessionOwned) registerMcpPromptCommands(service, pi, service.getMcpPromptServers(pi));
				else registerMcpPromptCommands(pi, service.getMcpPromptServers(pi));
			})();
			return attachPromise;
		};
		const onSessionStart = wrapAsync(
			"mcp.session_start",
			(event: SessionStartEvent, ctx: ExtensionContext) => attach(event, ctx),
			sink,
		);
		pi.on("session_start", (event, ctx) => {
			const work = onSessionStart(event, ctx);
			// First paint does not wait for attach; prompt preparation reuses its promise.
			void work;
		});
		const onBeforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> = async (
			event,
			ctx,
		) => {
			try {
				// A preview (senpi#2115) composes from the attach session_start already started:
				// it binds no elicitation UI, starts no attach, and attaches no skill-declared servers.
				const preview = event.preview === true;
				if (preview) {
					await attachPromise;
				} else {
					// Elicitation (todo 41): point mid-call forms at this session's UI.
					service.setMcpElicitationUiProvider(() => ctx.ui);
					await (attachPromise ?? attach({ type: "session_start", reason: "startup" }, ctx));
				}
				const skills = preview ? [] : ((event.systemPromptOptions.skills ?? []) as readonly SkillLike[]);
				if (skills.length > 0) {
					skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
					skillDecls = parseSkillMcpDeclarations(skills);
					const warnings = [
						...skillDecls.warnings,
						...(skillDecls.servers.size > 0 ? await service.attachSkillMcpServers(skillDecls.servers, pi) : []),
					];
					for (const warning of warnings) createMcpLogger("skills").warn(warning);
				}
				// Use the known instructions now. Deferred catalog registration refreshes
				// the service for subsequent turns instead of gating this provider request.
				const systemPrompt = injectMcpInstructions(service, event.systemPrompt);
				return systemPrompt === undefined ? undefined : { systemPrompt };
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				await reportMcpAsyncError("mcp.before_agent_start", error, sink);
				return undefined;
			}
		};
		pi.on("before_agent_start", onBeforeAgentStart, { previewSafe: true });
		pi.on(
			"session_shutdown",
			wrapAsync(
				"mcp.session_shutdown",
				async (event) => {
					if (sessionOwned) {
						disposeControlInventory();
						await service.handleSessionShutdown(event);
						return;
					}
					if (event.reason !== "reload") disposeControlInventory();
					// The shared service outlives any one session: release only this session's binding,
					// and dispose only when the last live session quits (#2514).
					await service.releaseSession(pi, event.reason === "quit" ? "quit" : undefined);
				},
				sink,
			),
		);
		pi.on(
			"session_extensions_removed",
			wrapAsync(
				"mcp.session_extensions_removed",
				async (event) => {
					if (event.removed.some((extension) => extension.path === MCP_BUILTIN_EXTENSION_PATH)) {
						disposeControlInventory();
						if (sessionOwned) await service.dispose("reload");
						else await service.releaseSession(pi, "reload");
					}
				},
				sink,
			),
		);
	};
}

function hasProviderScope(): boolean {
	try {
		bindToProviderScope(() => undefined);
		return true;
	} catch {
		return false;
	}
}

export default function mcpExtension(pi: ExtensionAPI): void | Promise<void> {
	const sessionOwned = hasProviderScope();
	return createMcpExtension(sessionOwned ? new McpService() : getMcpService(), sessionOwned)(pi);
}
