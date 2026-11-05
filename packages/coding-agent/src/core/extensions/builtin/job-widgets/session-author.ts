/**
 * The model-backed widget author of one session: the explicit `jobWidgets.model` setting, then the
 * host's route (`setJobWidgetAuthorResolver`), then the session's current model. The request goes
 * through the session's model runtime, so it uses the session's own credentials and provider hosts.
 */
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "../../types.ts";
import type { JobWidgetAuthor } from "./author-types.ts";
import { createModelJobWidgetAuthor, jobWidgetModelResolver } from "./model-author.ts";
import { jobWidgetHostResolver } from "./session-host.ts";

/** `provider/model-id`; the model id may itself hold `/`. */
function findSettingModel(ctx: ExtensionContext, reference: string): Model<Api> | undefined {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return undefined;
	return ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1));
}

export function createSessionJobWidgetAuthor(
	context: () => ExtensionContext | undefined,
	settingModel: string | undefined,
): JobWidgetAuthor {
	const withContext =
		<T>(read: (ctx: ExtensionContext) => T | undefined) =>
		(): T | undefined => {
			const ctx = context();
			return ctx === undefined ? undefined : read(ctx);
		};
	return createModelJobWidgetAuthor({
		resolveModel: jobWidgetModelResolver({
			setting: withContext((ctx) => (settingModel === undefined ? undefined : findSettingModel(ctx, settingModel))),
			host: withContext((ctx) => jobWidgetHostResolver()?.(ctx)),
			session: withContext((ctx) => ctx.model),
		}),
		complete: (model, request, options) => {
			const ctx = context();
			if (ctx === undefined) throw new Error("job widget author has no session context");
			return ctx.modelRegistry.modelRuntime.streamSimple(model, request, { ...options, cwd: ctx.cwd }).result();
		},
	});
}
