/**
 * Every free field of every exported answer (non-literal strings, `unknown`, index signatures), with where its
 * text comes from. A field whose text a caller, a configuration file, a provider or a process supplied can embed a
 * credential and cannot be typed away: the omo root refuses such a call to a session until a canary scan of its
 * output passes (security design 4.3). `engine` text is the engine's own fixed words. A pattern ending in `.*`
 * covers the subtree under it. `*` as the call is the answer envelope every function shares.
 */
export type ResultFieldOrigin = "caller" | "configuration" | "provider" | "process" | "engine";

export interface ResultFreeField {
	readonly call: string;
	readonly field: string;
	readonly origin: ResultFieldOrigin;
	readonly may_embed: boolean;
}

const embeds = <C extends string, F extends string, O extends Exclude<ResultFieldOrigin, "engine">>(
	call: C,
	field: F,
	origin: O,
) => ({ call, field, origin, may_embed: true }) as const;
const engineText = <C extends string, F extends string>(call: C, field: F) =>
	({ call, field, origin: "engine", may_embed: false }) as const;

export const RESULT_FREE_FIELDS = [
	embeds("*", "error.message", "caller"),
	embeds("*", "error.details", "process"),
	embeds("*", "error.details.*", "process"),
	embeds("*", "diagnostics.[].context", "configuration"),
	embeds("*", "diagnostics.[].message", "configuration"),
	embeds("*", "diagnostics.[].stack", "process"),
	embeds("packages.install", "value.source", "caller"),
	embeds("packages.remove", "value.source", "caller"),
	embeds("packages.update", "value.source", "caller"),
	embeds("packages.list", "value.packages.[].source", "configuration"),
	embeds("packages.list", "value.packages.[].installedPath", "configuration"),
	engineText("models.update", "value"),
	embeds("models.discover", "value.providerId", "caller"),
	embeds("models.discover", "value.url", "configuration"),
	embeds("models.discover", "value.modelsPath", "configuration"),
	embeds("models.discover", "value.backupPath", "configuration"),
	embeds("models.discover", "value.added.[]", "provider"),
	embeds("models.discover", "value.updated.[]", "provider"),
	embeds("models.discover", "value.unchanged.[]", "provider"),
	embeds("models.discover", "value.unlisted.[]", "configuration"),
	embeds("models.discover", "value.efforts", "provider"),
	embeds("models.discover", "value.efforts.*", "provider"),
	embeds("models.list", "value.loadError", "configuration"),
	embeds("models.list", "value.models.*", "configuration"),
	engineText("config.agentDir", "value.brandedPrefix"),
	engineText("config.agentDir", "value.source"),
	embeds("config.agentDir", "value.dir", "configuration"),
	embeds("config.resources", "value.*", "configuration"),
	embeds("config.setResource", "value.source", "caller"),
	embeds("config.setResource", "value.resource.path", "caller"),
	embeds("schedule.list", "value.jobs.*", "configuration"),
	embeds("schedule.list", "value.invalid.[].file", "configuration"),
	embeds("schedule.list", "value.invalid.[].error", "configuration"),
	embeds("schedule.list", "value.runners.[].exec", "configuration"),
	embeds("schedule.cancel", "value.id", "caller"),
	embeds("sessionOfPid", "value.sessionId", "process"),
	embeds("sessions.exportHtml", "value.path", "caller"),
	engineText("promptSizes", "value.mcp.note"),
	engineText("promptSizes", "value.presetPartsMismatch.note"),
	engineText("promptSizes", "value.thirdPartySessionStart.note"),
	embeds("promptSizes", "value.mcp.names.[]", "configuration"),
	embeds("promptSizes", "value.presetPartsMismatch.names.[]", "configuration"),
	embeds("promptSizes", "value.thirdPartySessionStart.names.[]", "configuration"),
	embeds("promptSizes", "value.sections.*", "configuration"),
	engineText("tips", "value.[].id"),
	engineText("tips", "value.[].text"),
	engineText("tips", "value.[].requiresCommand"),
	embeds("host.ensure", "value.payload", "process"),
	embeds("host.ensure", "value.payload.*", "process"),
	embeds("host.status", "value.payload", "process"),
	embeds("host.status", "value.payload.*", "process"),
	embeds("host.stop", "value.payload", "process"),
	embeds("host.stop", "value.payload.*", "process"),
	embeds("host.handoff", "value.payload", "process"),
	embeds("host.handoff", "value.payload.*", "process"),
	embeds("host.gc", "value.payload", "process"),
	embeds("host.gc", "value.payload.*", "process"),
	embeds("host.shardPath", "value.payload", "process"),
	embeds("host.shardPath", "value.payload.*", "process"),
	embeds("auth.check", "value.provider", "caller"),
	embeds("auth.check", "value.accounts.[].name", "configuration"),
	embeds("auth.check", "value.accounts.[].displayName", "configuration"),
	embeds("auth.check", "value.accounts.[].email", "provider"),
	embeds("auth.check", "value.accounts.[].subscriptionType", "provider"),
	embeds("auth.check", "value.accounts.[].orgName", "provider"),
	embeds("auth.check", "value.accounts.[].usageUrl", "configuration"),
	embeds("auth.check", "value.accounts.[].blockedModels.[].model", "configuration"),
	embeds("auth.check", "value.accounts.[].check.model", "configuration"),
	engineText("auth.check", "value.accounts.[].check.message"),
	embeds("auth.check", "value.accounts.[].check.provider_text.*", "provider"),
	embeds("launch.interactive", "value.session", "caller"),
	embeds("launch.rpc", "value.address", "caller"),
	embeds("launch.hand", "value.socket", "configuration"),
	embeds("launch.headless", "value.socket", "caller"),
	embeds("launch.print#events", "event", "process"),
	embeds("launch.print#events", "text", "process"),
	embeds("launch.print#events", "session", "process"),
] as const satisfies readonly ResultFreeField[];
