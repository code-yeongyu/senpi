import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../types.ts";
import { registerMcpCommands } from "./commands.ts";
import { AnthropicNativeToolSearchAdapter } from "./expose/native-search.ts";
import { MCP_SEARCH_TOOL_NAME } from "./expose/tool-search.ts";
import { injectMcpInstructions, refreshMcpInstructionsForSession } from "./instructions.ts";
import { createMcpLogger } from "./log.ts";
import { expandMcpResourceMentions } from "./resources.ts";
import { getMcpService } from "./service.ts";
import {
	parseSkillMcpDeclarations,
	type SkillLike,
	type SkillMcpDeclarations,
	skillActivationTargets,
} from "./skills.ts";
import { reportMcpAsyncError, wrapAsync } from "./wrap.ts";

export default function mcpExtension(pi: ExtensionAPI): void {
	let attachPromise: Promise<void> | undefined;
	const sink = {
		logger: {
			error(message: string, data?: unknown): void {
				createMcpLogger("service").error(message, data);
			},
		},
	};

	registerMcpCommands(pi);

	// Native provider tool-search adapter (todo 33 — Anthropic, spike = GO).
	// Runs on every request but is a no-op unless settings.nativeToolSearch is
	// auto|true and the model is anthropic-messages; a 400 disables it for the
	// session and falls back to the always-registered local mcp_search.
	const nativeAdapter = new AnthropicNativeToolSearchAdapter({
		enabled: () => {
			const setting = getMcpService().getNativeToolSearchSetting();
			return setting === true || setting === "auto";
		},
		isDeferrable: (name) => name.startsWith("mcp_") && name !== MCP_SEARCH_TOOL_NAME,
		onFallback: (reason) => createMcpLogger("service").warn(reason),
		searchToolName: MCP_SEARCH_TOOL_NAME,
	});
	pi.on("before_provider_request", (event, ctx) => nativeAdapter.applyBeforeRequest(ctx.model?.api, event.payload));
	pi.on("after_provider_response", (event) => nativeAdapter.noteResponseStatus(event.status));
	// Resumed/compacted sessions carry mcp_search activation markers in their
	// history but re-enter search mode with only directTools active. The context
	// event (fired before each LLM call, with the full message history) replays
	// the markers as a safety net; the primary replay happens at attach time so
	// the FIRST turn's payload already carries previously promoted tools. Scans
	// once per registration (see McpService.maybeRehydrateFromHistory).
	pi.on("context", (event) => {
		getMcpService().maybeRehydrateFromHistory(event.messages);
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
		const service = getMcpService();
		const registered = service.getTierBSearchable();
		const targets = skillActivationTargets(skillDecls, skillName, registered);
		if (targets.length > 0) service.activateSkillMcpTools(targets);
	};
	pi.on("input", async (event, ctx) => {
		const match = /^\s*\/skill:([A-Za-z0-9._-]+)/.exec(event.text);
		if (match) revealSkill(match[1]);
		// @mcp:<server>/<uri> mention expansion (todo 39): recognized mentions are
		// inlined via the sanctioned input transform; failures pass through
		// untouched with a one-line notice so submission is never blocked.
		if (event.text.includes("@mcp:")) {
			const expansion = await expandMcpResourceMentions(event.text, () => getMcpService().getMcpResourceServers());
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

	// Attach is SINGLE-FLIGHT. session_start handlers are dispatched
	// fire-and-forget, so a slow attach (a cold MCP server's boot + catalog
	// collection is awaited inside attachSession) can still be in flight when
	// before_agent_start fires. The old `attached` boolean was only set on
	// completion, so before_agent_start would start a SECOND concurrent attach —
	// which found the connection entries already created (still "connecting"),
	// collected an empty catalog, and registered no MCP tools for turn 1; the
	// first attach then landed the real registration turns later. Memoizing the
	// in-flight promise makes before_agent_start await the ORIGINAL attach, so
	// the first turn's payload deterministically carries the MCP tool set.
	// session_start always starts a fresh attach (reloads must re-sync config).
	const attach = (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
		attachPromise = (async () => {
			const service = getMcpService();
			await service.attachSession(event, ctx, pi);
			refreshMcpInstructionsForSession(service);
		})();
		return attachPromise;
	};
	pi.on(
		"session_start",
		wrapAsync("mcp.session_start", (event, ctx) => attach(event, ctx), sink),
	);
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			await (attachPromise ?? attach({ type: "session_start", reason: "startup" }, ctx));
			const skills = (event.systemPromptOptions.skills ?? []) as readonly SkillLike[];
			if (skills.length > 0) {
				skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
				skillDecls = parseSkillMcpDeclarations(skills);
				const declared = new Map(
					[...skillDecls.servers].map(([name, decl]) => [name, { raw: decl.raw, sourcePath: decl.sourcePath }]),
				);
				const warnings = [
					...skillDecls.warnings,
					...(declared.size > 0 ? await getMcpService().attachSkillMcpServers(declared) : []),
				];
				for (const warning of warnings) createMcpLogger("skills").warn(warning);
			}
			const systemPrompt = injectMcpInstructions(event.systemPrompt);
			return systemPrompt === undefined ? undefined : { systemPrompt };
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			await reportMcpAsyncError("mcp.before_agent_start", error, sink);
			return undefined;
		}
	});
	pi.on(
		"session_shutdown",
		wrapAsync("mcp.session_shutdown", (event) => getMcpService().handleSessionShutdown(event), sink),
	);
}
