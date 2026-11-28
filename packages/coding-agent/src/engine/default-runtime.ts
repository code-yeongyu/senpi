import { parseArgs } from "../cli/args.ts";
import { getAgentDir } from "../config.ts";
import { createAgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { createAgentSessionServices } from "../core/agent-session-services.ts";
import { builtInExtensions } from "../extensions/index.ts";
import type { PromptSizeReport } from "../core/prompt-size-report.ts";
import { SessionManager } from "../core/session-manager.ts";
import { createCliRuntimeFactory } from "../main.ts";
import { type ModelListing, type ModelsListInput, listModelsOf } from "./models.ts";
import { measurePromptSizes, type PromptSizesCode } from "./prompt-sizes.ts";
import { type EngineDiagnostic, type EngineOk, type EngineResult, engineError, errorMessage } from "./result.ts";

/**
 * `models.list` over the runtime a plain `--list-models` builds: built-in extensions, no launch setup.
 * The launch setup flags join the input in E1a-s.
 */
export async function listModelsWithDefaultRuntime(input: ModelsListInput): Promise<EngineOk<ModelListing>> {
	const services = await createAgentSessionServices({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		resourceLoaderOptions: {
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: builtInExtensions,
		},
	});
	const diagnostics: EngineDiagnostic[] = services.diagnostics.map(({ type, message }) => ({
		kind: "runtime",
		type,
		message,
	}));
	return { ...listModelsOf(services.modelRuntime, input), diagnostics };
}

/**
 * `promptSizes` over the session a plain `--print-prompt-sizes` opens, kept in memory so nothing is
 * written. The launch setup joins the input in E1a-s.
 */
export async function promptSizesWithDefaultRuntime(): Promise<EngineResult<PromptSizeReport, PromptSizesCode>> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	try {
		runtime = await createAgentSessionRuntime(
			createCliRuntimeFactory({ parsed: parseArgs(["--print-prompt-sizes"]), cwd, agentDir, appMode: "print" }),
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
