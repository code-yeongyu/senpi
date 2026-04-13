import { SettingsManager } from "../../../settings-manager.js";
import type { ExtensionAPI } from "../../types.js";
import { extractPatchedPaths } from "../gpt-apply-patch.js";
import { parsePermissionFlag } from "./cli.js";
import { disabled } from "./config.js";
import { createEventEmitter } from "./events.js";
import { handleNoUI } from "./non-interactive.js";
import { createBuiltinParserRegistry, type ParserRegistry } from "./parsers.js";
import { showPermissionPrompt } from "./prompt.js";
import { PermissionService } from "./service.js";
import { loadPermissionSettings } from "./settings.js";
import { appendApproved } from "./storage.js";
import { CorrectedError, DeniedError, RejectedError, type Request, type Ruleset } from "./types.js";

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

	const nextRequestID = createRequestIDFactory();

	pi.registerFlag("permission", {
		description: "Set permission rules (format: tool=action or tool:pattern=action)",
		type: "string",
	});

	pi.on("session_start", async (_event, ctx) => {
		const settingsManager = SettingsManager.create(ctx.cwd);
		const permissionFlag = pi.getFlag("permission");
		cliRuleset = typeof permissionFlag === "string" ? parsePermissionFlag(permissionFlag) : [];

		const loadedSettings = loadPermissionSettings(settingsManager, cliRuleset, ctx.cwd);
		staticRuleset = loadedSettings.staticRuleset;
		const approved = loadedSettings.approved;
		parserRegistry = createBuiltinParserRegistry();
		service = new PermissionService(staticRuleset, approved, createEventEmitter(pi));
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

		const approved = service.getApproved().slice(initialApprovedCount);
		if (approved.length > 0) {
			appendApproved(ctx.cwd, approved);
		}

		for (const pendingRequest of service.list()) {
			service.reply({ requestID: pendingRequest.id, reply: "reject" });
		}
	});
}
