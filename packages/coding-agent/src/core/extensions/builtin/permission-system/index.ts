import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "../../types.ts";
import { extractPatchedPaths } from "../gpt-apply-patch/index.ts";
import { decideAuto } from "./auto-policy.ts";
import { PERMISSION_PRESET_NAMES, parsePermissionFlag, parsePermissionPresetFlag } from "./cli.ts";
import { disabled, fromConfig } from "./config.ts";
import { forgetDispatchApproval, registerDispatchAuthorizer } from "./dispatch.ts";
import { prepareMcpDispatchApproval } from "./dispatch-metadata.ts";
import { createDispatchAuthorizer } from "./dispatch-policy.ts";
import { createEventEmitter } from "./events.ts";
import { INTERNAL_PERMISSION_TOOLS } from "./internal-tools.ts";
import { handleNoUI } from "./non-interactive.ts";
import {
	createBuiltinParserRegistry,
	type ParserRegistry,
	permissionRequestsFor,
	toolOwnedPermissionRequests,
} from "./parsers.ts";
import { registerPermissionPresetReader } from "./preset-registry.ts";
import { showPermissionPrompt } from "./prompt.ts";
import { PermissionService } from "./service.ts";
import { loadPermissionSettings } from "./settings.ts";
import { appendApproved } from "./storage.ts";
import {
	CorrectedError,
	DeniedError,
	type PermissionConfig,
	type PermissionPresetName,
	RejectedError,
	type Request,
	type Ruleset,
} from "./types.ts";
import { Wildcard } from "./wildcard.ts";

function createRequestIDFactory(): () => string {
	let counter = 0;
	return () => {
		counter += 1;
		return `permission-${counter}`;
	};
}

function getReason(error: unknown): string {
	if (error instanceof DeniedError || error instanceof CorrectedError || error instanceof RejectedError) {
		return error.message;
	}

	if (error instanceof Error) {
		return error.message;
	}

	return "Permission request was rejected.";
}

/**
 * A DeniedError's refusal: the model-facing sentence that tells it not to retry, then the exact
 * settings rule and its layer so the user can change it.
 */
function denyReason(
	error: DeniedError,
	settingsManager: SettingsManager | null,
	cliRuleset: Ruleset,
	request: Request,
): string {
	if (settingsManager === null) return error.message;
	const provenance = findDenyProvenance(settingsManager, cliRuleset, request.permission, request.patterns);
	if (!provenance) return error.message;
	const source = provenance.layer === "cli" ? "--permission" : `${provenance.layer} settings.json`;
	// Only promise an unblock when no other layer still denies the call: naming the winning rule and
	// telling the user to edit it is wrong when a second deny would keep blocking.
	const unblock = provenance.otherLayerDenies ? "" : " The user can edit that entry to allow this call.";
	return `${error.message} Denied by ${provenance.layer} permission rule ${provenance.permission}:${provenance.pattern} = deny (${source}).${unblock}`;
}

/**
 * An "Always" answer takes effect for other open sessions at once: it is appended to the approved
 * store now, not at session shutdown (senpi#2465). The shutdown append then skips the rules this
 * session already persisted, so the JSONL contract keeps one line per rule.
 */
function persistAlways(agentDir: string, cwd: string, request: Request, persisted: Set<string>): void {
	const rules = request.always.map((pattern) => ({
		permission: request.permission,
		pattern,
		action: "allow" as const,
	}));
	if (rules.length === 0) return;
	// MEDIUM 4: a failed write (EACCES/ENOSPC) must not abort the tool call after the ask resolved;
	// the rule is left unmarked so the shutdown append retries it.
	try {
		appendApproved(agentDir, cwd, rules);
	} catch (error) {
		console.error(
			`permission: failed to persist an Always answer; it will be retried at shutdown (${getReason(error)})`,
		);
		return;
	}
	for (const rule of rules) persisted.add(`${rule.permission}:${rule.pattern}`);
}

/**
 * The settings deny rule that actually decided, using the same precedence as the decision
 * (global, then project, then CLI; last match wins within and across layers). A decision-time
 * deny is the last matching deny over the merged static ruleset, so the topmost layer with a
 * match is the winner. `otherLayerDenies` is true when a lower layer also matches, so the
 * refusal does not promise that editing the winning entry alone would unblock the call.
 */
function findDenyProvenance(
	settingsManager: SettingsManager,
	cliRuleset: Ruleset,
	permission: string,
	patterns: readonly string[],
):
	| {
			layer: "global" | "project" | "cli";
			permission: string;
			pattern: string;
			action: string;
			otherLayerDenies: boolean;
	  }
	| undefined {
	const matches = (rules: Ruleset) =>
		rules.filter(
			(rule) =>
				rule.action === "deny" &&
				Wildcard.match(permission, rule.permission) &&
				patterns.some(
					(value) =>
						Wildcard.match(value, rule.pattern) ||
						(rule.pattern.endsWith(" *") && Wildcard.match(value, rule.pattern.slice(0, -2))),
				),
		);
	const globalPermission = (settingsManager.getGlobalSettings() as { permission?: PermissionConfig }).permission;
	const globalMatches = matches(globalPermission ? fromConfig(globalPermission) : []);
	const projectPermission = (settingsManager.getProjectSettings() as { permission?: PermissionConfig }).permission;
	const projectMatches = matches(projectPermission ? fromConfig(projectPermission) : []);
	const cliMatches = matches(cliRuleset);
	if (cliMatches.length > 0) {
		return {
			layer: "cli",
			...cliMatches[cliMatches.length - 1],
			otherLayerDenies: projectMatches.length > 0 || globalMatches.length > 0,
		};
	}
	if (projectMatches.length > 0) {
		return {
			layer: "project",
			...projectMatches[projectMatches.length - 1],
			otherLayerDenies: globalMatches.length > 0,
		};
	}
	if (globalMatches.length > 0) {
		return { layer: "global", ...globalMatches[globalMatches.length - 1], otherLayerDenies: false };
	}
	return undefined;
}

function createRequestMetadata(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		toolName,
		...input,
	};

	const pathValue = typeof input.path === "string" ? input.path : undefined;
	const filePathValue = typeof input.file_path === "string" ? input.file_path : undefined;
	const patchTextValue =
		typeof input.input === "string" ? input.input : typeof input.patchText === "string" ? input.patchText : undefined;

	if (toolName === "edit" || toolName === "write" || toolName === "apply_patch" || toolName === "multiedit") {
		metadata.filepath = pathValue ?? filePathValue ?? extractPatchedPaths(patchTextValue ?? "")[0];
	}

	if (toolName === "read") {
		metadata.filePath = pathValue ?? filePathValue;
	}

	return metadata;
}

export default function permissionSystemExtension(pi: ExtensionAPI): void {
	let service: PermissionService | null = null;
	let parserRegistry: ParserRegistry | null = null;
	let cliRuleset: Ruleset = [];
	let staticRuleset: Ruleset = [];
	let activePreset: PermissionPresetName | null = null;
	let setupError: string | null = null;
	let activeSettingsManager: SettingsManager | null = null;
	// The `permission-preset` flag value the rules were last loaded from; absent until session_start.
	let loadedPresetFlag: { readonly value: boolean | string | undefined } | undefined;
	let loadedPermissionFlag: boolean | string | undefined;
	const retireAuthorizers = new WeakMap<object, () => void>();
	const retirePresetReaders = new WeakMap<object, () => void>();

	const nextRequestID = createRequestIDFactory();
	// Rules this session already persisted at answer time; shutdown skips re-appending them.
	const persistedAtAnswer = new Set<string>();

	pi.registerFlag("permission", {
		description: "Set permission rules (format: tool=action or tool:pattern=action)",
		type: "string",
	});
	pi.registerFlag("permission-preset", {
		description: `Set permission preset (${PERMISSION_PRESET_NAMES.join(", ")})`,
		type: "string",
	});

	pi.on("session_start", async (_event, ctx) => {
		// Registered before loading, so a failed load reports no preset instead of an older load's.
		retirePresetReaders.get(ctx.sessionManager)?.();
		retirePresetReaders.set(
			ctx.sessionManager,
			registerPermissionPresetReader(ctx.sessionManager, () => {
				followPresetFlag(ctx.cwd, ctx.agentDir);
				return setupError === null ? (activePreset ?? undefined) : undefined;
			}),
		);
		setupError = null;
		try {
			loadPermissionRules(ctx.cwd, [], ctx.agentDir);
		} catch (error) {
			// The runner reports a throwing handler and keeps the session running, so a rules
			// failure must block tool calls itself instead of leaving them unchecked (#2617).
			setupError = getReason(error);
			throw error;
		}
		retireAuthorizers.get(ctx.sessionManager)?.();
		retireAuthorizers.set(ctx.sessionManager, registerDispatchAuthorizer(ctx.sessionManager, dispatchAuthorizer));
		applyToolDenials();
	});

	// `sessionApproved` carries this session's "Always" answers, not yet written to disk, across a reload.
	const loadPermissionRules = (cwd: string, sessionApproved: Ruleset = [], agentDir?: string): void => {
		// The session's own agentDir scopes global settings; an ambient default would miss the
		// settings a host session actually runs with (senpi#2465).
		const settingsManager =
			agentDir === undefined ? SettingsManager.create(cwd) : SettingsManager.create(cwd, agentDir);
		activeSettingsManager = settingsManager;
		const permissionFlag = pi.getFlag("permission");
		loadedPermissionFlag = permissionFlag;
		const permissionPresetFlag = pi.getFlag("permission-preset");
		loadedPresetFlag = { value: permissionPresetFlag };
		cliRuleset = typeof permissionFlag === "string" ? parsePermissionFlag(permissionFlag) : [];
		const cliPreset =
			typeof permissionPresetFlag === "string" ? parsePermissionPresetFlag(permissionPresetFlag) : undefined;

		if (typeof permissionPresetFlag === "string" && !cliPreset) {
			throw new Error(
				`Invalid --permission-preset "${permissionPresetFlag}". Expected one of: ${PERMISSION_PRESET_NAMES.join(", ")}.`,
			);
		}

		const loadedSettings = loadPermissionSettings(settingsManager, cliRuleset, cwd, cliPreset, agentDir);
		staticRuleset = loadedSettings.staticRuleset;
		activePreset = loadedSettings.preset;
		const approved = loadedSettings.approved;
		parserRegistry = createBuiltinParserRegistry();
		service = new PermissionService(
			staticRuleset,
			[...approved, ...sessionApproved],
			createEventEmitter(pi),
			activePreset,
			cwd,
			agentDir,
		);
	};

	const applyToolDenials = (onlyWhenNarrowed = false): void => {
		const allTools = pi.getAllTools().map((tool) => tool.name);
		const disabledTools = disabled(allTools, staticRuleset);
		const currentTools = pi.getActiveTools();
		const activeTools = currentTools.filter(
			(toolName) => INTERNAL_PERMISSION_TOOLS.has(toolName) || !disabledTools.has(toolName),
		);
		if (onlyWhenNarrowed && activeTools.length === currentTools.length) return;
		pi.setActiveTools(activeTools);
	};

	// A host moves a live session to another preset (an attach naming one) by changing the flag;
	// the rules follow from the next tool call on, and a failed reload refuses calls like session_start.
	const followPresetFlag = (cwd: string, agentDir?: string): void => {
		if (
			loadedPresetFlag === undefined ||
			(loadedPresetFlag.value === pi.getFlag("permission-preset") &&
				loadedPermissionFlag === pi.getFlag("permission"))
		) {
			return;
		}
		const sessionApproved = service ? service.getSessionApproved() : [];
		setupError = null;
		try {
			loadPermissionRules(cwd, sessionApproved, agentDir);
		} catch (error) {
			setupError = getReason(error);
			return;
		}
		applyToolDenials(true);
	};

	const dispatchAuthorizer = createDispatchAuthorizer(
		pi,
		(ctx) => {
			followPresetFlag(ctx.cwd, ctx.agentDir);
			return { service, parsers: parserRegistry, preset: activePreset, setupError };
		},
		(event, ctx, signal) => authorizeToolCall(event, ctx, signal),
	);

	const authorizeToolCall = async (
		event: ToolCallEvent,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<ToolCallEventResult | undefined> => {
		followPresetFlag(ctx.cwd, ctx.agentDir);
		if (setupError !== null) {
			return { block: true, reason: `Permission setup failed: ${setupError}` };
		}
		// Pinned for this call: a preset change while it waits on a prompt must not move its reply
		// to another service or its decision to another preset.
		const activeService = service;
		const callPreset = activePreset;
		if (!activeService || !parserRegistry) {
			return undefined;
		}

		// Resolve the tool list lazily: getAllTools throws while the runtime initializes
		// (the shutdown regression fires a tool_call during load), and a tool the builtin
		// registry owns (bash, read, edit, write) never needs it, so it must run only for
		// a genuinely tool-owned parse.
		const getTools = () => pi.getAllTools();
		const toolOwnedRequests = parserRegistry.has(event.toolName)
			? undefined
			: toolOwnedPermissionRequests(getTools(), event.toolName, event.input, ctx.cwd);
		// Parsing preserves a path monitor's approved parent. Only rearming is
		// bookkeeping; path watches read file bytes and retain filesystem checks.
		if (
			INTERNAL_PERMISSION_TOOLS.has(event.toolName) &&
			(event.toolName === "monitor" ? event.input.action === "rearm" : toolOwnedRequests === undefined)
		) {
			return undefined;
		}
		const permissionRequests = permissionRequestsFor(getTools, parserRegistry, event.toolName, event.input, ctx.cwd);
		const sessionID = ctx.sessionManager.getSessionId();
		const approve = prepareMcpDispatchApproval(pi, event, ctx, dispatchAuthorizer);

		for (const permissionRequest of permissionRequests) {
			const request: Request = {
				id: nextRequestID(),
				sessionID,
				permission: permissionRequest.permission,
				patterns: permissionRequest.patterns,
				always: permissionRequest.always,
				...(permissionRequest.originalPaths ? { originalPaths: permissionRequest.originalPaths } : {}),
				...(permissionRequest.widerAlways ? { widerAlways: permissionRequest.widerAlways } : {}),
				metadata: createRequestMetadata(event.toolName, event.input),
				tool: {
					callID: event.toolCallId,
					...(event.parentToolCallId === undefined ? {} : { parentCallID: event.parentToolCallId }),
				},
			};

			const auto =
				callPreset === "auto"
					? await decideAuto(event.toolName, event.input, permissionRequest, ctx.cwd)
					: undefined;
			const askResultPromise = activeService
				.ask(request, {
					autoApproveAsk: permissionRequest.autoApproveAsk ?? false,
					approveBlanketAsk: auto?.approveBlanketAsk ?? false,
					presetBound: callPreset === "auto",
					...(permissionRequest.ruleAliases ? { ruleAliases: permissionRequest.ruleAliases } : {}),
				})
				.then(
					() => ({ ok: true as const }),
					(error: unknown) => ({ ok: false as const, error }),
				);
			const isPending = activeService.list().some((pendingRequest) => pendingRequest.id === request.id);

			if (!isPending) {
				const askResult = await askResultPromise;
				if (!askResult.ok) {
					return {
						block: true,
						reason:
							askResult.error instanceof DeniedError
								? denyReason(askResult.error, activeSettingsManager, cliRuleset, request)
								: getReason(askResult.error),
					};
				}
				continue;
			}

			if (ctx.hasUI) {
				const reply = await showPermissionPrompt(ctx, request, signal);
				activeService.reply(reply);
				if (reply.reply === "always") {
					const answered = reply.always ? { ...request, always: reply.always } : request;
					persistAlways(ctx.agentDir, ctx.cwd, answered, persistedAtAnswer);
				}
			} else {
				activeService.reply(
					handleNoUI(request, {
						emitEvent: (eventName, data) => {
							if (eventName !== "permission_asked") {
								pi.events.emit(eventName, data);
							}
						},
						presetBound: callPreset === "auto",
					}),
				);
			}

			const askResult = await askResultPromise;
			if (!askResult.ok) {
				return {
					block: true,
					reason:
						askResult.error instanceof DeniedError
							? denyReason(askResult.error, activeSettingsManager, cliRuleset, request)
							: getReason(askResult.error),
				};
			}
		}

		approve?.();
		return undefined;
	};
	pi.on("tool_call", authorizeToolCall);
	pi.on("tool_result", (event) => forgetDispatchApproval(event.input));

	pi.on("session_shutdown", async (event, ctx) => {
		void event;
		retireAuthorizers.get(ctx.sessionManager)?.();
		retireAuthorizers.delete(ctx.sessionManager);
		retirePresetReaders.get(ctx.sessionManager)?.();
		retirePresetReaders.delete(ctx.sessionManager);

		if (!service) {
			return;
		}

		const approved = service
			.getSessionApproved()
			.filter((rule) => !persistedAtAnswer.has(`${rule.permission}:${rule.pattern}`));
		if (approved.length > 0) {
			appendApproved(ctx.agentDir, ctx.cwd, approved);
		}

		for (const pendingRequest of service.list()) {
			service.reply({ requestID: pendingRequest.id, reply: "reject" });
		}
	});
}
