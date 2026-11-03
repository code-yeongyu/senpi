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
import { createMcpSkillReveal } from "./skill-reveal.ts";
import type { SkillLike } from "./skills.ts";
import { reportMcpAsyncError, safeEventBusOn, wrapAsync } from "./wrap.ts";

const MCP_BUILTIN_EXTENSION_PATH = "<builtin:mcp>";

export function createMcpExtension(service: McpService, sessionOwned = true): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		// The latest attach, for the commands and as the fallback of a context with no attach of its own.
		let attachPromise: Promise<void> | undefined;
		// Every attached scope's session (brain/hand S16c): a runtime that serves several scopes attaches each one at its
		// first tool call, and each keeps its control inventory. A session_start makes this one session again.
		const attachedSessionIds = new Set<string>();
		// Each context's own attach, so a scope's turn waits for its own servers and not for another scope's attach.
		const scopeAttaches = new WeakMap<object, Promise<void>>();
		const runtimeKey = {};
		const contextKey = (ctx: ExtensionContext): object => ctx.sessionManager ?? runtimeKey;
		let controlInventoryDisposed = false;
		const unsubscribeControlInventoryRequest = safeEventBusOn(
			pi.events,
			MCP_CONTROL_INVENTORY_REQUEST_EVENT,
			(data) => {
				if (!isMcpControlInventoryRequest(data) || !attachedSessionIds.has(data.sessionId)) return;
				data.respond(service.refreshWireStatusSnapshot(data.sessionId));
			},
		);
		const unsubscribeWireStatus = service.onWireStatusChanged((sessionId, snapshot, startupSettled) => {
			if (sessionId === undefined || !attachedSessionIds.has(sessionId)) return;
			pi.events.emit(
				MCP_CONTROL_INVENTORY_CHANGED_EVENT,
				startupSettled ? { sessionId, snapshot, startupSettled: true } : { sessionId, snapshot },
			);
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
		// Each execution scope reveals its own skills (brain/hand S16c): one scope's turn neither replaces another's
		// skills nor uses up its reveal of the same one.
		const skillReveal = createMcpSkillReveal({
			registered: () => service.getTierBSearchable(pi),
			activate: (targets) => service.activateSkillMcpTools(targets, pi),
		});
		pi.on("input", async (event, ctx) => {
			service.bindMcpMrtrPresentation(pi, ctx.ui, ctx.sessionManager);
			const match = /^\s*\/skill:([A-Za-z0-9._-]+)/.exec(event.text);
			if (match) skillReveal.reveal(contextKey(ctx), match[1]);
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
		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "read") return undefined;
			const path = (event.input as { path?: string }).path;
			if (path === undefined) return undefined;
			const scope = contextKey(ctx);
			for (const [name, skill] of skillReveal.skills(scope)) {
				if (path === skill.filePath || path.endsWith(skill.filePath)) skillReveal.reveal(scope, name);
			}
			return undefined;
		});

		// Attach is single-flight: the prompt uses the original attach's bindings
		// and known catalog, without waiting for deferred remote discovery.
		// session_start always starts a fresh attach (reloads must re-sync config).
		const attach = (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			if (sessionId !== undefined) attachedSessionIds.add(sessionId);
			attachPromise = (async () => {
				await service.attachSession(event, ctx, pi);
				refreshMcpInstructionsForSession(service);
				if (sessionOwned) registerMcpPromptCommands(service, pi, service.getMcpPromptServers(pi));
				else registerMcpPromptCommands(pi, service.getMcpPromptServers(pi));
			})();
			scopeAttaches.set(contextKey(ctx), attachPromise);
			return attachPromise;
		};
		const onSessionStart = wrapAsync(
			"mcp.session_start",
			(event: SessionStartEvent, ctx: ExtensionContext) => attach(event, ctx),
			sink,
		);
		// Boot point (senpi#5229): a session attaches at session_start and binds its UI before each turn; a runtime
		// with no session attaches at the first tool call of a context and binds elicitation to that context's UI
		// (the runtime's UI broker). Each context attaches once; a context with no session manager is the runtime.
		const attachedContexts = new WeakSet<object>();
		// A further context of a runtime that already attached joins that binding instead of taking it over: both
		// scopes' calls stay served, and each keeps its own forms, presentation and inventory (brain/hand S16c).
		const joinScope = wrapAsync(
			"mcp.attach_scope",
			async (ctx: ExtensionContext) => {
				await attachPromise;
				await service.attachScope(ctx, pi);
			},
			sink,
		);
		// A session drops this hook at session_start, so its tool calls emit no tool_hook_status for it (senpi#5320).
		const dropFirstUseAttach = pi.on("tool_call", (_event, ctx) => {
			const key = contextKey(ctx);
			if (attachedContexts.has(key)) return undefined;
			attachedContexts.add(key);
			service.setMcpElicitationUiProvider(() => (ctx.hasUI ? ctx.ui : undefined));
			if (attachPromise === undefined) {
				void onSessionStart({ type: "session_start", reason: "startup" }, ctx);
				return undefined;
			}
			const sessionId = ctx.sessionManager?.getSessionId?.();
			if (sessionId !== undefined) attachedSessionIds.add(sessionId);
			scopeAttaches.set(key, joinScope(ctx));
			return undefined;
		});
		pi.on("session_start", (event, ctx) => {
			dropFirstUseAttach();
			if (event.sizesOnly) return;
			attachedSessionIds.clear();
			attachedContexts.add(contextKey(ctx));
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
				const ownAttach = scopeAttaches.get(contextKey(ctx)) ?? attachPromise;
				if (preview) {
					await ownAttach;
				} else {
					// Elicitation (todo 41): point mid-call forms at this session's UI.
					service.setMcpElicitationUiProvider(() => (ctx.hasUI ? ctx.ui : undefined));
					await (ownAttach ?? attach({ type: "session_start", reason: "startup" }, ctx));
					service.bindMcpMrtrPresentation(pi, ctx.ui, ctx.sessionManager);
				}
				const skills = preview ? [] : ((event.systemPromptOptions.skills ?? []) as readonly SkillLike[]);
				if (skills.length > 0) {
					const skillDecls = skillReveal.startTurn(contextKey(ctx), skills);
					const warnings = [
						...skillDecls.warnings,
						...(skillDecls.servers.size > 0 ? await service.attachSkillMcpServers(skillDecls.servers, pi) : []),
					];
					for (const warning of warnings) {
						if (!warning.startsWith("Project MCP server")) createMcpLogger("skills").warn(warning);
						if (warning.startsWith("Blocked skill link")) {
							pi.events.emit("security_notice", { category: "skill-link-blocked", message: warning });
						}
					}
				}
				// Use the known instructions now. Deferred catalog registration refreshes
				// the service for subsequent turns instead of gating this provider request.
				const systemPrompt = injectMcpInstructions(service, event.systemPrompt);
				return systemPrompt === undefined ? undefined : { systemPrompt, systemPromptCache: "volatile" };
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				await reportMcpAsyncError("mcp.before_agent_start", error, sink);
				return undefined;
			}
		};
		pi.on("before_agent_start", onBeforeAgentStart, { previewSafe: true, runLast: true });
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
					// A reload builds a new runner whose factory subscribes again, so this generation's listeners go
					// now too: left on the process-wide service they keep the old runner and its whole extension
					// graph reachable, one generation per reload.
					disposeControlInventory();
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
