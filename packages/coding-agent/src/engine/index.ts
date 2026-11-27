/**
 * `@code-yeongyu/senpi/engine`: one typed function per engine command the omo launcher forwards
 * (senpi#7450). Each answers data or a typed refusal; none prints or exits. The CLI commands are
 * renderers over the same functions. Endpoint, key-root, presenter and launch-setup inputs are not
 * exported here; they arrive with the security design (E1a-s), and `ENGINE_COMMANDS` marks them.
 */

import { config, queries, schedule } from "./exported-config.ts";
import { host } from "./exported-host.ts";
import { models, packages } from "./exported-packages.ts";

export type { AgentDirectorySelection } from "./agent-directory.ts";
export type { ChangedResource, ResolvedResources, ResourceConfigCode, ResourceRef } from "./config.ts";
export type { ResourceSetting, ResourcesInput, GlobalResourceSetting, ProjectResourceSetting } from "./config.ts";
export type { HostAnswer, HostCode } from "./host.ts";
export type {
	HostEnsureInput,
	HostGcInput,
	HostHandoffInput,
	HostShardPathInput,
	HostStatusInput,
	HostStopInput,
} from "./host.ts";
export { ENGINE_COMMANDS, GATED_SLICE } from "./metadata.ts";
export type {
	EngineCommandFlag,
	EngineCommandMetadata,
	EngineCommandPositional,
	EngineFlagMapping,
} from "./metadata.ts";
export type { ListedModel, ModelListing, ModelsDiscoverInput, ModelsListInput } from "./models.ts";
export type {
	PackageCommandCode,
	PackageCommandOptions,
	PackageListInput,
	PackageSourceInput,
	PackageUpdateInput,
} from "./packages.ts";
export type { PromptSizesCode } from "./prompt-sizes.ts";
export type { ExportHtmlInput } from "./queries.ts";
export type { SessionOfPidInput } from "./session-of-pid.ts";
export type { EngineDiagnostic, EngineError, EngineOk, EngineResult } from "./result.ts";
export type {
	ScheduleCancelInput,
	ScheduleListing,
	ScheduleRunEvent,
	ScheduleRunInput,
	ScheduleRunOptions,
} from "./schedule.ts";
export type { InvalidInput } from "./input.ts";

/** The engine's own commands as functions, in the process's working directory and agent directory. */
export const engine = {
	packages,
	models,
	config,
	schedule,
	sessionOfPid: queries.sessionOfPid,
	sessions: queries.sessions,
	promptSizes: queries.promptSizes,
	tips: queries.tips,
	host,
} as const;
