import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "../../../core/thinking-levels.ts";
import { SENPI_COLLABORATION_MODE } from "../protocol/collaboration-mode.ts";
import type { ThreadSettings, ThreadSettingsUpdateResponse } from "../protocol/index.ts";
import type { MethodHandler, MethodRegistry, RegistryConnection, RpcRequest } from "../rpc/registry.ts";
import type { NotificationRouter } from "../server/notifications.ts";
import { connectionId, objectValue, requiredString } from "./handler-params.ts";
import { type ThreadEntry, ThreadNotFoundError, type ThreadRegistry } from "./registry.ts";
import { invalidParams, invalidRequest } from "./turn-runtime.ts";

export interface ThreadSettingsHandlersOptions {
	readonly threads: ThreadRegistry;
	readonly notifications: NotificationRouter;
	readonly deferUntilResponded?: (connectionId: string, action: () => Promise<void> | void) => boolean;
}

type SettingsHandlerRegistration = {
	readonly method: string;
	readonly handler: MethodHandler;
};

export function registerThreadSettingsHandlers(registry: MethodRegistry, options: ThreadSettingsHandlersOptions): void {
	const handlers = new ThreadSettingsHandlers(options);
	for (const registration of handlers.registrations()) {
		registry.register(registration.method, {
			handler: registration.handler,
			scope: "thread",
			experimental: true,
		});
	}
}

class ThreadSettingsHandlers {
	private readonly threads: ThreadRegistry;
	private readonly notifications: NotificationRouter;
	private readonly deferUntilResponded:
		| ((connectionId: string, action: () => Promise<void> | void) => boolean)
		| undefined;

	constructor(options: ThreadSettingsHandlersOptions) {
		this.threads = options.threads;
		this.notifications = options.notifications;
		this.deferUntilResponded = options.deferUntilResponded;
	}

	registrations(): readonly SettingsHandlerRegistration[] {
		return [
			{ method: "thread/settings/update", handler: (context) => this.update(context.connection, context.request) },
		];
	}

	private async update(connection: RegistryConnection, request: RpcRequest): Promise<ThreadSettingsUpdateResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const unsupported = Object.keys(params)
			.filter((key) => key !== "threadId" && key !== "model" && key !== "effort")
			.sort();
		if (unsupported.length > 0) {
			throw invalidRequest(`unsupported thread settings: ${unsupported.join(", ")}`);
		}

		const entry = await this.requireThread(threadId);
		const requestedModel = parseModel(params, entry);
		const requestedEffort = parseEffort(params, requestedModel, entry);
		const before = buildThreadSettings(entry);
		if (requestedModel && !sameModel(requestedModel, entry.session.model)) {
			await entry.session.setSessionModel(requestedModel);
		}
		if (requestedEffort !== undefined && requestedEffort !== entry.session.thinkingLevel) {
			entry.session.setSessionThinkingLevel(requestedEffort);
		}

		const after = buildThreadSettings(entry);
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			const notify = (): void => {
				this.notifications.toThread(threadId, {
					method: "thread/settings/updated",
					params: { threadId, threadSettings: after },
				});
			};
			if (this.deferUntilResponded?.(connectionId(connection), notify) !== true) notify();
		}
		return {};
	}

	private async requireThread(threadId: string): Promise<ThreadEntry> {
		try {
			return await this.threads.resumeThread(threadId);
		} catch (error) {
			if (error instanceof ThreadNotFoundError) throw invalidRequest(`thread not found: ${threadId}`);
			throw error;
		}
	}
}

function parseModel(params: Readonly<Record<string, unknown>>, entry: ThreadEntry): Model<Api> | undefined {
	if (!Object.hasOwn(params, "model") || params.model === null) return undefined;
	if (typeof params.model !== "string" || params.model.length === 0) {
		throw invalidParams("Invalid params: model must be a non-empty string");
	}
	const reference = params.model;
	const separator = reference.indexOf("/");
	const model =
		separator > 0
			? entry.session.modelRegistry.find(reference.slice(0, separator), reference.slice(separator + 1))
			: entry.session.modelRegistry.getAll().find((candidate) => candidate.id === reference);
	if (!model) throw invalidRequest(`model not found: ${reference}`);
	return model;
}

function parseEffort(
	params: Readonly<Record<string, unknown>>,
	model: Model<Api> | undefined,
	entry: ThreadEntry,
): ThinkingLevel | undefined {
	if (!Object.hasOwn(params, "effort") || params.effort === null) return undefined;
	if (typeof params.effort !== "string") {
		throw invalidParams("Invalid params: effort must be a string");
	}
	const levels = model ? getSupportedThinkingLevels(model) : entry.session.getAvailableThinkingLevels();
	const effort = levels.find((level) => level === params.effort);
	if (!effort) throw invalidParams(`Invalid params: unsupported effort ${params.effort}`);
	return effort;
}

type ModelIdentity = { readonly provider: string; readonly id: string };

function sameModel(left: Model<Api>, right: ModelIdentity | undefined): boolean {
	return right?.provider === left.provider && right.id === left.id;
}

function buildThreadSettings(entry: ThreadEntry): ThreadSettings {
	const model = entry.session.model;
	const settings = {
		cwd: entry.cwd,
		approvalPolicy: "never",
		approvalsReviewer: "user",
		sandboxPolicy: { type: "dangerFullAccess" },
		activePermissionProfile: null,
		model: model?.id ?? "unknown",
		modelProvider: model?.provider ?? "unknown",
		serviceTier: entry.session.serviceTier ?? null,
		effort: entry.session.thinkingLevel,
		summary: null,
		collaborationMode: SENPI_COLLABORATION_MODE,
		personality: null,
	} satisfies ThreadSettings;
	return settings;
}
