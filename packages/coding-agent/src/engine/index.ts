/**
 * `@code-yeongyu/senpi/engine`: one typed function per engine command the omo launcher forwards
 * (senpi#7450, senpi#7451). Each answers data or a typed refusal; none prints or exits. The CLI commands
 * are renderers over the same cores. No exported function answers a credential: the provider-credential
 * operations refuse, and a launch takes a key only as a readable handle it delivers to the launched process.
 */

import { auth, launch } from "./exported-launch.ts";
import { config, queries, schedule } from "./exported-config.ts";
import { host } from "./exported-host.ts";
import { models, packages } from "./exported-packages.ts";

export type { AgentDirectorySelection } from "./agent-directory.ts";
export type { ChangedResource, ResolvedResources, ResourceConfigCode, ResourceRef } from "./config.ts";
export type { ResourceSetting, ResourcesInput, GlobalResourceSetting, ProjectResourceSetting } from "./config.ts";
export type {
	AuthBearerTokenInput,
	AuthCheckCode,
	AuthCheckInput,
	AuthCredentialCode,
	AuthCredentialsInput,
	AuthStatus,
	AuthTargetInput,
} from "./auth.ts";
export type { AuthAccount, AuthAccountCheck, AuthAccountCheckCode } from "../cli/auth-account-check.ts";
export { AUTH_ACCOUNT_CHECK_CODES } from "../cli/auth-account-check.ts";
export type { PromptSizesInput } from "./default-runtime.ts";
export type { HostAnswer, HostCode, HostEndpointSelector, HostPresenterInput } from "./host.ts";
export type { LaunchCode, LaunchedEngine, LaunchExit, LaunchRpcAnswer, LaunchSocketAnswer } from "./launch.ts";
export {
	LaunchInputSchema,
	LaunchOptionsSchema,
	LaunchPresenterSchema,
	LaunchSessionSchema,
	LaunchSetupSchema,
} from "./launch-options.ts";
export type {
	LaunchHandOptions,
	LaunchHeadlessOptions,
	LaunchInput,
	LaunchInteractiveOptions,
	LaunchKeyHandle,
	LaunchMode,
	LaunchOptions,
	LaunchPrintOptions,
	LaunchRpcOptions,
	LaunchSession,
	LaunchSetup,
} from "./launch-options.ts";
export type { LaunchPrintEvent, LaunchPrintRun } from "./launch-print-stream.ts";
export type {
	HostEnsureInput,
	HostGcInput,
	HostHandoffInput,
	HostShardPathInput,
	HostStatusInput,
	HostStopInput,
} from "./host.ts";
export { ENGINE_COMMANDS } from "./metadata.ts";
export type {
	EngineCommandFlag,
	EngineCommandMetadata,
	EngineCommandPositional,
	EngineFlagFormat,
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
	auth,
	launch,
} as const;
