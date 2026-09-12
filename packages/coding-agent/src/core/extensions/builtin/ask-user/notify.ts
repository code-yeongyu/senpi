import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { loadHookConfigSources } from "../hooks/config-loader.ts";
import {
	buildNotificationHookInput,
	dispatchNotificationHookEvent,
	notificationResultDetails,
	recordLifecycleHookResult,
} from "../hooks/lifecycle-adapter.ts";
import { emptyHookTrustState } from "../hooks/trust.ts";
import { FileHookStateStorage } from "../hooks/trust-storage.ts";
import { formatResultText } from "./format.ts";
import type { QuestionRequest, QuestionResponse } from "./schema.ts";

export async function emitAskUserNotification(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: QuestionRequest,
	response: QuestionResponse,
	variant: "codex" | "claude",
): Promise<void> {
	let handlers: Awaited<ReturnType<typeof loadHookConfigSources>>["executableHandlers"] = [];
	let trust = emptyHookTrustState();
	try {
		const sources = ctx.getLoadedHookSources?.() ?? {
			agentDir: ctx.cwd,
			cwd: ctx.cwd,
			globalHookSourcePaths: [],
			globalHooksPath: `${ctx.cwd}/hooks.json`,
			preSessionHookSourcePaths: [],
			projectHookSourcePaths: [],
			projectHooksPath: `${ctx.cwd}/.senpi/hooks.json`,
			runtimeHookSourcePaths: [],
		};
		const parsed = loadHookConfigSources({
			agentDir: sources.agentDir,
			cwd: sources.cwd,
			fileSystem: {
				readTextFile(path) {
					return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
				},
			},
			globalHookSourcePaths: sources.globalHookSourcePaths,
			globalHooksPath: sources.globalHooksPath,
			globalSettingsHooks: sources.globalSettingsHooks,
			preSessionHookSourcePaths: sources.preSessionHookSourcePaths,
			projectHookSourcePaths: sources.projectHookSourcePaths,
			projectHooksPath: sources.projectHooksPath,
			projectSettingsHooks: sources.projectSettingsHooks,
			runtimeHookSourcePaths: sources.runtimeHookSourcePaths,
		});
		handlers = parsed.executableHandlers;
		const storage = new FileHookStateStorage({ agentDir: sources.agentDir, cwd: sources.cwd });
		trust = ctx.isProjectTrusted() ? storage.read("project") : emptyHookTrustState();
		const globalTrust = storage.read("global");
		trust = { version: 1, hooks: { ...globalTrust.hooks, ...trust.hooks } };
	} catch {
		return;
	}
	const headers = request.questions.map((q) => q.header).join(", ");
	const message =
		response.status === "timed_out"
			? `Question timed out (${headers}): ${formatResultText(variant, response, request.questions)}`
			: `Question ${response.status} (${headers})`;
	try {
		const result = await dispatchNotificationHookEvent({
			cwd: ctx.cwd,
			handlers,
			input: buildNotificationHookInput(
				{
					kind: response.status === "timed_out" ? "ask-user-timeout" : "ask-user-settled",
					message,
					requestId: request.requestId,
					source: "ask-user",
					status: response.status,
					title: headers,
				},
				ctx,
			),
			...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			trustState: trust,
		});
		const details = notificationResultDetails(result);
		recordLifecycleHookResult(pi, "Notification", details);
		return;
	} catch {
		return;
	}
}
