import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AttachPrompt, AttachStartup } from "../modes/interactive/attach-startup.ts";
import { type Args, isValidThinkingLevel } from "./args.ts";
import { processFileArguments } from "./file-processor.ts";

export type HeldSessionAttachPlan = { readonly startup: AttachStartup } | { readonly refusal: string };

const refusal = (reason: string): HeldSessionAttachPlan => ({
	refusal: `${reason} This session runs in a multi-session host, so this terminal attaches to it and applies the command line through the session's own commands.`,
});

/**
 * The command line of a terminal start that attaches to a host-held session (senpi#6911): its prompts, `@file`
 * arguments, `--model` and `--thinking` become the attached session's own commands, never dropped silently. What
 * cannot be applied exactly (a model pattern without a provider) refuses the start instead.
 */
export async function heldSessionAttachPlan(
	parsed: Args,
	options: { readonly autoResizeImages: boolean },
): Promise<HeldSessionAttachPlan> {
	let thinking: ThinkingLevel | undefined = parsed.thinking;
	let model: AttachStartup["model"];
	if (parsed.model !== undefined) {
		let provider = parsed.provider;
		let modelId = parsed.model;
		if (provider === undefined) {
			const slash = modelId.indexOf("/");
			if (slash <= 0) {
				return refusal(
					`--model ${parsed.model} names no provider: use --provider <name> --model <id> or --model <provider>/<id>.`,
				);
			}
			provider = modelId.slice(0, slash);
			modelId = modelId.slice(slash + 1);
		}
		const colon = modelId.lastIndexOf(":");
		const suffix = colon > 0 ? modelId.slice(colon + 1) : "";
		if (isValidThinkingLevel(suffix)) {
			thinking ??= suffix;
			modelId = modelId.slice(0, colon);
		}
		if (modelId === "" || modelId.includes("*")) {
			return refusal(`--model ${parsed.model} is a pattern; name one model as <provider>/<id>.`);
		}
		model = { provider, modelId };
	} else if (parsed.provider !== undefined) {
		return refusal(`--provider ${parsed.provider} needs --model.`);
	}
	return {
		startup: {
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
			prompts: await attachPrompts(parsed, options.autoResizeImages),
		},
	};
}

/** The first prompt carries the `@file` text and images before the first message, as an in-process start sends it. */
async function attachPrompts(parsed: Args, autoResizeImages: boolean): Promise<AttachPrompt[]> {
	const [first, ...rest] = parsed.messages;
	const prompts: AttachPrompt[] = rest.map((text) => ({ text }));
	if (parsed.fileArgs.length === 0) return first === undefined ? prompts : [{ text: first }, ...prompts];
	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return [{ text: `${text}${first ?? ""}`, ...(images.length > 0 ? { images } : {}) }, ...prompts];
}
