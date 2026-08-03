import { convertToLlm, filterContextExcludedMessages } from "../../../messages.ts";
import { buildSessionContext } from "../../../session-manager.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI } from "../../types.ts";
import { extractPatchedPaths } from "../gpt-apply-patch/index.ts";
import { type AutoClassifierDecision, runAutoClassifier } from "./auto-classifier.ts";
import { parsePermissionFlag, parsePermissionPresetFlag } from "./cli.ts";
import { disabled } from "./config.ts";
import { createEventEmitter } from "./events.ts";
import { ApprovalModeCycle } from "./mode-cycle.ts";
import { handleNoUI } from "./non-interactive.ts";
import { createBuiltinParserRegistry, type ParserRegistry } from "./parsers.ts";
import { showPermissionPrompt } from "./prompt.ts";
import { PermissionService } from "./service.ts";
import { loadPermissionSettings } from "./settings.ts";
import { appendApproved } from "./storage.ts";
import { CorrectedError, DeniedError, RejectedError, type Request, type Ruleset } from "./types.ts";

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
	let initialApprovedCount = 0;
	let approvalModeCycle: ApprovalModeCycle | null = null;
	let classifierWarningShown = false;

	const nextRequestID = createRequestIDFactory();

	pi.registerFlag("permission", {
		description: "Set permission rules (format: tool=action or tool:pattern=action)",
		type: "string",
	});
	pi.registerFlag("permission-preset", {
		description: "Set permission preset (full-access, auto, workspace, read-only, or ask)",
		type: "string",
	});
	pi.registerCommand("approval-mode-cycle", {
		description: "Cycle approval mode",
		handler: async () => {
			approvalModeCycle?.next();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const settingsManager = SettingsManager.create(ctx.cwd);
		const permissionFlag = pi.getFlag("permission");
		const permissionPresetFlag = pi.getFlag("permission-preset");
		cliRuleset = typeof permissionFlag === "string" ? parsePermissionFlag(permissionFlag) : [];
		const cliPreset =
			typeof permissionPresetFlag === "string" ? parsePermissionPresetFlag(permissionPresetFlag) : undefined;

		if (typeof permissionPresetFlag === "string" && !cliPreset) {
			throw new Error(
				`Invalid --permission-preset "${permissionPresetFlag}". Expected one of: full-access, workspace, read-only, ask.`,
			);
		}

		const loadedSettings = loadPermissionSettings(settingsManager, cliRuleset, ctx.cwd, cliPreset);
		staticRuleset = loadedSettings.staticRuleset;
		const approved = loadedSettings.approved;
		parserRegistry = createBuiltinParserRegistry();
		service = new PermissionService(
			staticRuleset,
			approved,
			createEventEmitter(pi),
			cliRuleset,
			loadedSettings.settingsRuleset,
		);
		approvalModeCycle = new ApprovalModeCycle(service, loadedSettings.activePreset, ctx.ui);
		classifierWarningShown = false;
		initialApprovedCount = approved.length;

		const allTools = pi.getAllTools().map((tool) => tool.name);
		const disabledTools = disabled(allTools, staticRuleset);
		const activeTools = pi.getActiveTools().filter((toolName) => !disabledTools.has(toolName));
		pi.setActiveTools(activeTools);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!service || !parserRegistry) {
			return undefined;
		}

		const permissionRequests = parserRegistry.parse(event.toolName, event.input, ctx.cwd);
		const sessionID = ctx.sessionManager.getSessionId();
		let autoDecision: Promise<AutoClassifierDecision> | undefined;

		for (const permissionRequest of permissionRequests) {
			const request: Request = {
				id: nextRequestID(),
				sessionID,
				permission: permissionRequest.permission,
				patterns: permissionRequest.patterns,
				always: permissionRequest.always,
				metadata: createRequestMetadata(event.toolName, event.input),
			};

			const askPromise = service.ask(request);
			const isPending = service.list().some((pendingRequest) => pendingRequest.id === request.id);

			if (!isPending) {
				try {
					await askPromise;
				} catch (error) {
					return { block: true, reason: getReason(error) };
				}
				continue;
			}

			if (approvalModeCycle?.isAuto() && service.isAutoApprovalEligible(request)) {
				autoDecision ??= (async () => {
					const model = ctx.model;
					if (!model) return { action: "ask", stage: "screen", error: "no active model" };
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok) return { action: "ask", stage: "screen", error: auth.error };
					const snapshot = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
					const history = convertToLlm(filterContextExcludedMessages(snapshot.messages));
					return runAutoClassifier(
						{
							model,
							auth: { apiKey: auth.apiKey, headers: auth.headers, extraBody: auth.extraBody },
							sessionId: sessionID,
							streamFn: (streamModel, streamContext, options) =>
								ctx.modelRegistry.modelRuntime.streamSimple(streamModel, streamContext, options),
						},
						{ history, proposal: { toolName: event.toolName, input: event.input } },
					);
				})();
				const decision = await autoDecision;
				if (decision.action === "allow") {
					service.reply({ requestID: request.id, reply: "once" });
					await askPromise;
					continue;
				}
				if (decision.error && ctx.hasUI && !classifierWarningShown) {
					classifierWarningShown = true;
					ctx.ui.notify(`Auto approval classifier unavailable: ${decision.error}`, "warning");
				}
			}

			if (ctx.hasUI) {
				const reply = await showPermissionPrompt(ctx, request);
				service.reply(reply);
			} else {
				const reply = handleNoUI(request, staticRuleset, cliRuleset, (eventName, data) => {
					if (eventName !== "permission_asked") {
						pi.events.emit(eventName, data);
					}
				});
				if (reply) {
					service.reply(reply);
				}
			}

			try {
				await askPromise;
			} catch (error) {
				return { block: true, reason: getReason(error) };
			}
		}

		return undefined;
	});

	pi.on("session_shutdown", async (event, ctx) => {
		void event;

		if (!service) {
			return;
		}
		approvalModeCycle = null;
		if (ctx.hasUI) ctx.ui.setStatus("approval-mode", undefined);

		const approved = service.getApproved().slice(initialApprovedCount);
		if (approved.length > 0) {
			appendApproved(ctx.cwd, approved);
		}

		for (const pendingRequest of service.list()) {
			service.reply({ requestID: pendingRequest.id, reply: "reject" });
		}
	});
}
