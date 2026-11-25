import { createModelListingServices } from "../cli/model-listing.ts";
import { getAgentDir } from "../config.ts";
import { createAgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { PromptSizeReport } from "../core/prompt-size-report.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { builtInExtensions } from "../extensions/index.ts";
import { createCliRuntimeFactory } from "../main.ts";
import { parseLaunchArgv, setupArgv } from "./launch-argv.ts";
import type { LaunchSetup } from "./launch-options.ts";
import { type ModelListing, type ModelsListInput, listModelsOf } from "./models.ts";
import { measurePromptSizes, type PromptSizesCode } from "./prompt-sizes.ts";
import { type EngineDiagnostic, type EngineResult, engineError, errorMessage } from "./result.ts";

export interface PromptSizesInput {
	readonly setup?: LaunchSetup;
}

/** `models.list`: the listing `--list-models` prints, over the runtime the same launch setup builds. */
export async function listModelsForSetup(input: ModelsListInput): Promise<EngineResult<ModelListing, "invalid_input">> {
	const parsed = parseLaunchArgv(setupArgv(input.setup));
	if ("refusal" in parsed) return engineError("invalid_input", parsed.refusal);
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const services = await createModelListingServices(parsed.args, {
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir),
		extensionFactories: builtInExtensions,
	});
	const diagnostics: EngineDiagnostic[] = services.diagnostics.map(({ type, message }) => ({
		kind: "runtime",
		type,
		message,
	}));
	const listing = listModelsOf(services.modelRuntime, input.pattern === undefined ? {} : { pattern: input.pattern });
	return { ...listing, diagnostics };
}

/**
 * `promptSizes`: the report `--print-prompt-sizes` prints for the same launch setup, over a session kept in
 * memory so nothing is written.
 */
export async function promptSizesForSetup(
	input: PromptSizesInput,
): Promise<EngineResult<PromptSizeReport, PromptSizesCode | "invalid_input">> {
	const parsed = parseLaunchArgv(["--print-prompt-sizes", ...setupArgv(input.setup)]);
	if ("refusal" in parsed) return engineError("invalid_input", parsed.refusal);
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	try {
		runtime = await createAgentSessionRuntime(
			createCliRuntimeFactory({ parsed: parsed.args, cwd, agentDir, appMode: "print" }),
			{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
		);
	} catch (error: unknown) {
		return engineError("unmeasurable", errorMessage(error, "session initialization failed"));
	}
	try {
		return await measurePromptSizes(runtime);
	} finally {
		await runtime.dispose();
	}
}
