import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "../../types.ts";
import { extractPatchedPaths } from "../gpt-apply-patch/index.ts";
import { decideAuto } from "./auto-policy.ts";
import { PERMISSION_PRESET_NAMES, parsePermissionFlag, parsePermissionPresetFlag } from "./cli.ts";
import { disabled } from "./config.ts";
import { forgetDispatchApproval, registerDispatchAuthorizer } from "./dispatch.ts";
import { prepareMcpDispatchApproval } from "./dispatch-metadata.ts";
import { createDispatchAuthorizer } from "./dispatch-policy.ts";
import { createEventEmitter } from "./events.ts";
import { INTERNAL_PERMISSION_TOOLS } from "./internal-tools.ts";
import { handleNoUI } from "./non-interactive.ts";
import { createBuiltinParserRegistry, type ParserRegistry, toolOwnedPermissionRequests } from "./parsers.ts";
import { showPermissionPrompt } from "./prompt.ts";
import { PermissionService } from "./service.ts";
import { loadPermissionSettings } from "./settings.ts";
import { appendApproved } from "./storage.ts";
import {
	CorrectedError,
	DeniedError,
	type PermissionPresetName,
	RejectedError,
	type Request,
	type Ruleset,
} from "./types.ts";

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
	let initialApprovedCount = 0;
	let setupError: string | null = null;
	// The `permission-preset` flag value the rules were last loaded from; absent until session_start.
	let loadedPresetFlag: { readonly value: boolean | string | undefined } | undefined;
	let loadedPermissionFlag: boolean | string | undefined;
	const retireAuthorizers = new WeakMap<object, () => void>();

	const nextRequestID = createRequestIDFactory();

	pi.registerFlag("permission", {
		description: "Set permission rules (format: tool=action or tool:pattern=action)",
		type: "string",
	});
	pi.registerFlag("permission-preset", {
		description: `Set permission preset (${PERMISSION_PRESET_NAMES.join(", ")})`,
		type: "string",
	});

	pi.on("session_start", async (_event, ctx) => {
		setupError = null;
		try {
			loadPermissionRules(ctx.cwd);
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
	const loadPermissionRules = (cwd: string, sessionApproved: Ruleset = []): void => {
		const settingsManager = SettingsManager.create(cwd);
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

		const loadedSettings = loadPermissionSettings(settingsManager, cliRuleset, cwd, cliPreset);
		staticRuleset = loadedSettings.staticRuleset;
		activePreset = loadedSettings.preset;
		const approved = loadedSettings.approved;
		parserRegistry = createBuiltinParserRegistry();
		service = new PermissionService(staticRuleset, [...approved, ...sessionApproved], createEventEmitter(pi));
		initialApprovedCount = approved.length;
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
	const followPresetFlag = (cwd: string): void => {
		if (
			loadedPresetFlag === undefined ||
			(loadedPresetFlag.value === pi.getFlag("permission-preset") &&
				loadedPermissionFlag === pi.getFlag("permission"))
		) {
			return;
		}
		const sessionApproved = service ? service.getApproved().slice(initialApprovedCount) : [];
		setupError = null;
		try {
			loadPermissionRules(cwd, sessionApproved);
		} catch (error) {
			setupError = getReason(error);
			return;
		}
		applyToolDenials(true);
	};

	const dispatchAuthorizer = createDispatchAuthorizer(
		pi,
		(ctx) => {
			followPresetFlag(ctx.cwd);
			return { service, parsers: parserRegistry, preset: activePreset, setupError };
		},
		(event, ctx, signal) => authorizeToolCall(event, ctx, signal),
	);

	const authorizeToolCall = async (
		event: ToolCallEvent,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<ToolCallEventResult | undefined> => {
		followPresetFlag(ctx.cwd);
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

		const toolOwnedRequests = parserRegistry.has(event.toolName)
			? undefined
			: toolOwnedPermissionRequests(pi.getAllTools(), event.toolName, event.input, ctx.cwd);
		const permissionRequests = toolOwnedRequests ?? parserRegistry.parse(event.toolName, event.input, ctx.cwd);
		// Parsing preserves a path monitor's approved parent. Only rearming is
		// bookkeeping; path watches read file bytes and retain filesystem checks.
		if (
			INTERNAL_PERMISSION_TOOLS.has(event.toolName) &&
			(event.toolName === "monitor" ? event.input.action === "rearm" : toolOwnedRequests === undefined)
		) {
			return undefined;
		}
		const sessionID = ctx.sessionManager.getSessionId();
		const approve = prepareMcpDispatchApproval(pi, event, ctx, dispatchAuthorizer);

		for (const permissionRequest of permissionRequests) {
			const request: Request = {
				id: nextRequestID(),
				sessionID,
				permission: permissionRequest.permission,
				patterns: permissionRequest.patterns,
				always: permissionRequest.always,
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
					return { block: true, reason: getReason(askResult.error) };
				}
				continue;
			}

			if (ctx.hasUI) {
				const reply = await showPermissionPrompt(ctx, request, signal);
				activeService.reply(reply);
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
				return { block: true, reason: getReason(askResult.error) };
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

		if (!service) {
			return;
		}

		const approved = service.getApproved().slice(initialApprovedCount);
		if (approved.length > 0) {
			appendApproved(ctx.cwd, approved);
		}

		for (const pendingRequest of service.list()) {
			service.reply({ requestID: pendingRequest.id, reply: "reject" });
		}
	});
}
