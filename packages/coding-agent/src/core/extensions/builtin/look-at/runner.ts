import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	ModelsSimpleStreamOptions,
	TextContent,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "../../types.ts";
import type { NormalizedLookAtArgs } from "./arguments.ts";
import { loadLookAtInputs } from "./image-input.ts";
import { resolveVisionModel } from "./model-selector.ts";
import { buildLookAtUserMessage, LOOK_AT_SYSTEM_PROMPT } from "./prompts.ts";
import { type LookAtStore, loadLookAtChain } from "./settings.ts";

const LOOK_AT_TIMEOUT_MS = 120_000;

export type LookAtStreamRunner = (
	model: Model<Api>,
	context: Context,
	options: ModelsSimpleStreamOptions,
) => AssistantMessageEventStream;

export interface LookAtRunnerDependencies {
	streamRunner?: LookAtStreamRunner;
}

export interface LookAtRunResult {
	model: string;
	sources: string[];
	mimeTypes: string[];
	text: string;
}

export async function runLookAt(
	args: NormalizedLookAtArgs,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	store: LookAtStore,
	dependencies: LookAtRunnerDependencies = {},
): Promise<LookAtRunResult> {
	throwIfAborted(signal);
	const inputs = await loadLookAtInputs(ctx, inputPaths(args), inputData(args));
	const resolved = resolveVisionModel(loadLookAtChain(ctx, store), ctx.modelRegistry.getAvailable());
	if (!resolved) {
		throw new Error(
			"No image-capable model is available. Configure a vision-capable provider and try look_at again.",
		);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
	if (!auth.ok) {
		throw new Error(
			`look_at cannot use ${resolved.model.provider}/${resolved.model.id}: ${auth.error}. ` +
				`Configure credentials with /login ${resolved.model.provider} and try again.`,
		);
	}
	throwIfAborted(signal);

	const request = createRequestSignal(signal);
	try {
		const userMessage: UserMessage = {
			role: "user",
			content: [
				...inputs.map(toImageBlock),
				{
					type: "text",
					text: buildLookAtUserMessage(
						args.goal,
						inputs.map((input) => input.label),
					),
				},
			],
			timestamp: Date.now(),
		};
		const streamRunner =
			dependencies.streamRunner ??
			((model, context, options) => ctx.modelRegistry.modelRuntime.streamSimple(model, context, options));
		const reasoning = toStreamReasoning(resolved.thinkingLevel);
		const response = await streamRunner(
			resolved.model,
			{ systemPrompt: LOOK_AT_SYSTEM_PROMPT, messages: [userMessage] },
			{
				...(reasoning === undefined ? {} : { reasoning }),
				maxTokens: 4096,
				signal: request.signal,
			},
		).result();

		return {
			model: `${resolved.model.provider}/${resolved.model.id}`,
			sources: inputs.map((input) => input.label),
			mimeTypes: inputs.map((input) => input.mimeType),
			text: responseText(response, request.signal),
		};
	} catch (error) {
		if (request.signal.aborted) throw new Error("look_at analysis was aborted.");
		throw error;
	} finally {
		request.dispose();
	}
}

function inputPaths(args: NormalizedLookAtArgs): string[] {
	return args.file_paths ?? (args.file_path ? [args.file_path] : []);
}

function inputData(args: NormalizedLookAtArgs): string[] {
	return args.image_data_list ?? (args.image_data ? [args.image_data] : []);
}

function toImageBlock(input: { data: string; mimeType: string }): ImageContent {
	return { type: "image", data: input.data, mimeType: input.mimeType };
}

function responseText(response: AssistantMessage, signal: AbortSignal): string {
	if (response.stopReason === "error") {
		const providerMessage = response.errorMessage ?? "The vision provider returned an unspecified error.";
		throw new Error(`Vision model failed to analyze the supplied media: ${providerMessage}`);
	}
	if (response.stopReason === "aborted" || signal.aborted) {
		throw new Error("look_at analysis was aborted.");
	}
	const text = response.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!text) {
		throw new Error("Vision model returned no analysis text. Try a clearer goal or another image.");
	}
	return text;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("look_at analysis was aborted.");
}

function toStreamReasoning(level: ThinkingLevel | undefined): ModelsSimpleStreamOptions["reasoning"] {
	if (level === undefined || level === "off") return undefined;
	return level as ModelsSimpleStreamOptions["reasoning"];
}

function createRequestSignal(signal: AbortSignal | undefined): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const abortFromTool = () => controller.abort(signal?.reason);
	if (signal?.aborted) abortFromTool();
	else signal?.addEventListener("abort", abortFromTool, { once: true });
	const timeout = setTimeout(() => controller.abort(), LOOK_AT_TIMEOUT_MS);

	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromTool);
		},
	};
}
