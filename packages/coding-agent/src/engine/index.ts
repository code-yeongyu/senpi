/**
 * `@code-yeongyu/senpi/engine`: one typed function per engine command the omo launcher forwards
 * (senpi#7450, senpi#7451). Each answers data or a typed refusal; none prints or exits. The CLI commands
 * are renderers over the same cores. No exported function answers a credential: the provider-credential
 * operations refuse, and a launch takes a key only as a readable handle it delivers to the launched process.
 */
import { getAgentDir } from "../config.ts";
import { builtInExtensions } from "../extensions/index.ts";
import { agentDirectory } from "./agent-directory.ts";
import type { EngineCommandScope } from "./command-settings.ts";
import { type ResourcesInput, type ResourceSetting, openResourceConfig, setResource } from "./config.ts";
import {
	apiKey,
	type AuthBearerTokenInput,
	type AuthCheckInput,
	type AuthCredentialsInput,
	type AuthTargetInput,
	bearerToken,
	checkAuth,
	credentials,
} from "./auth.ts";
import { listModelsForSetup, type PromptSizesInput, promptSizesForSetup } from "./default-runtime.ts";
import { launchHand, launchHeadless, launchInteractive, launchPrint, launchRpc } from "./launch.ts";
import type {
	LaunchHandOptions,
	LaunchHeadlessOptions,
	LaunchInteractiveOptions,
	LaunchPrintOptions,
	LaunchRpcOptions,
} from "./launch-options.ts";
import { defaultLaunchPorts } from "./launch-process.ts";
import {
	type HostEnsureInput,
	type HostGcInput,
	type HostHandoffInput,
	type HostShardPathInput,
	type HostStatusInput,
	type HostStopInput,
	hostEndpointOptions,
	runHostOperation,
} from "./host.ts";
import { discoverModels, type ModelsDiscoverInput, type ModelsListInput, updateModelCatalogs } from "./models.ts";
import {
	installPackage,
	listPackages,
	type PackageCommandCode,
	type PackageCommandOptions,
	type PackageListInput,
	type PackageSourceInput,
	type PackageUpdateInput,
	removePackage,
	updatePackages,
} from "./packages.ts";
import { type ExportHtmlInput, exportSessionHtml } from "./queries.ts";
import { type SessionOfPidInput, sessionOfPid } from "./session-of-pid.ts";
import {
	cancelSchedule,
	listSchedules,
	runSchedule,
	type ScheduleCancelInput,
	type ScheduleRunInput,
	type ScheduleRunOptions,
} from "./schedule.ts";
import { tips } from "./tips.ts";

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
export type { HostEnsureInput, HostGcInput, HostHandoffInput, HostShardPathInput, HostStatusInput, HostStopInput };
export { ENGINE_COMMANDS } from "./metadata.ts";
export type {
	EngineCommandFlag,
	EngineCommandMetadata,
	EngineCommandPositional,
	EngineFlagFormat,
	EngineFlagMapping,
} from "./metadata.ts";
export type { ModelListing, ModelsDiscoverInput, ModelsListInput } from "./models.ts";
export type { PackageCommandCode, PackageCommandOptions, PackageListInput, PackageSourceInput, PackageUpdateInput };
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

function processScope(): EngineCommandScope {
	return { cwd: process.cwd(), agentDir: getAgentDir(), extensionFactories: builtInExtensions };
}

function launchPorts() {
	return defaultLaunchPorts(getAgentDir);
}

function progressOnly(options: PackageCommandOptions | undefined): PackageCommandOptions {
	return options?.onProgress === undefined ? {} : { onProgress: options.onProgress };
}

function trustOf(input: { readonly trust?: boolean }): { readonly trust?: boolean } {
	return input.trust === undefined ? {} : { trust: input.trust };
}

/** The engine's own commands as functions, in the process's working directory and agent directory. */
export const engine = {
	packages: {
		install: (input: PackageSourceInput, options?: PackageCommandOptions) =>
			installPackage(
				processScope(),
				{ source: input.source, local: input.local === true, ...trustOf(input) },
				progressOnly(options),
			),
		remove: (input: PackageSourceInput, options?: PackageCommandOptions) =>
			removePackage(
				processScope(),
				{ source: input.source, local: input.local === true, ...trustOf(input) },
				progressOnly(options),
			),
		list: (input: PackageListInput = {}) => listPackages(processScope(), trustOf(input)),
		update: (input: PackageUpdateInput = {}, options?: PackageCommandOptions) =>
			updatePackages(
				processScope(),
				{ ...(input.source === undefined ? {} : { source: input.source }), ...trustOf(input) },
				progressOnly(options),
			),
	},
	models: {
		update: () => updateModelCatalogs({ agentDir: getAgentDir() }),
		discover: (input: ModelsDiscoverInput) =>
			discoverModels({ agentDir: getAgentDir() }, { provider: input.provider }),
		list: (input: ModelsListInput = {}) => listModelsForSetup(input),
	},
	config: {
		agentDir: () => agentDirectory(),
		resources: async (input: ResourcesInput = {}) => {
			const opened = await openResourceConfig(processScope(), { local: input.local === true, ...trustOf(input) });
			if (opened.kind === "error") return opened;
			const { settingsManager: _settings, ...resources } = opened.value;
			return { ...opened, value: resources };
		},
		setResource: (setting: ResourceSetting) =>
			setResource(
				processScope(),
				setting.local === true
					? {
							local: true,
							source: setting.source,
							resource: setting.resource,
							state: setting.state,
							...trustOf(setting),
						}
					: { source: setting.source, resource: setting.resource, enabled: setting.enabled },
			),
	},
	schedule: {
		list: () => listSchedules({ agentDir: getAgentDir() }),
		cancel: (input: ScheduleCancelInput) => cancelSchedule({ agentDir: getAgentDir() }, { id: input.id }),
		run: (input: ScheduleRunInput, options: ScheduleRunOptions) =>
			runSchedule({ agentDir: getAgentDir() }, input, { onEvent: options.onEvent }),
	},
	sessionOfPid: (input: SessionOfPidInput) => sessionOfPid({ pid: input.pid }),
	auth: {
		check: (input: AuthCheckInput) => checkAuth(input),
		credentials: (input: AuthCredentialsInput) => credentials(input),
		apiKey: (input: AuthTargetInput) => apiKey(input),
		bearerToken: (input: AuthBearerTokenInput) => bearerToken(input),
	},
	launch: {
		interactive: (options: LaunchInteractiveOptions = {}) => launchInteractive(launchPorts(), options),
		print: (options: LaunchPrintOptions) => launchPrint(launchPorts(), options),
		rpc: (options: LaunchRpcOptions = {}) => launchRpc(launchPorts(), options),
		hand: (options: LaunchHandOptions = {}) => launchHand(launchPorts(), options),
		headless: (options: LaunchHeadlessOptions = {}) => launchHeadless(launchPorts(), options),
	},
	sessions: {
		exportHtml: (input: ExportHtmlInput) =>
			exportSessionHtml({ session: input.session, ...(input.out === undefined ? {} : { out: input.out }) }),
	},
	promptSizes: (input: PromptSizesInput = {}) => promptSizesForSetup(input),
	tips: () => tips(),
	host: {
		ensure: (input: HostEnsureInput = {}) =>
			runHostOperation(
				{
					operation: "ensure",
					...(input.launch_spec === undefined ? {} : { launch_spec: input.launch_spec }),
					...(input.policy === undefined ? {} : { policy: input.policy }),
				},
				hostEndpointOptions(input),
			),
		status: (input: HostStatusInput = {}) =>
			runHostOperation(
				{
					operation: "status",
					all: input.all === true,
					include_workers: input.include_workers === true,
				},
				hostEndpointOptions(input),
			),
		stop: (input: HostStopInput = {}) =>
			runHostOperation(
				{
					operation: "stop",
					drain: input.drain === true,
					force: input.force === true,
					...(input.instance === undefined ? {} : { instance: input.instance }),
					...(input.wait_ms === undefined ? {} : { wait_ms: input.wait_ms }),
					...(input.expected_generation === undefined ? {} : { expected_generation: input.expected_generation }),
				},
				hostEndpointOptions(input),
			),
		handoff: (input: HostHandoffInput = {}) =>
			runHostOperation(
				{
					operation: "handoff",
					...(input.launch_spec === undefined ? {} : { launch_spec: input.launch_spec }),
					...(input.allow_downgrade === true ? { allow_downgrade: true } : {}),
					...(input.when === undefined ? {} : { when: input.when }),
				},
				hostEndpointOptions(input),
			),
		gc: (input: HostGcInput = {}) =>
			runHostOperation(
				{
					operation: "gc",
					...(input.agent_dir === undefined ? {} : { agent_dir: input.agent_dir }),
				},
				hostEndpointOptions(input),
			),
		shardPath: (input: HostShardPathInput) =>
			runHostOperation(
				{
					operation: "shard_path",
					kind: input.kind,
					owner: input.owner,
					...(input.root === undefined ? {} : { root: input.root }),
				},
				hostEndpointOptions(input),
			),
	},
} as const;
