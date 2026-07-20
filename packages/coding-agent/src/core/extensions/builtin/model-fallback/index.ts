import { validateFallbackChains } from "../../../retry-fallback/validate.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { loadFallbackSettings, updateFallbackSettings } from "./settings.ts";
import { runFallbackMenu } from "./ui.ts";

const FLAG_NAME = "no-model-fallback";

export default function modelFallbackExtension(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG_NAME, {
		type: "boolean",
		default: false,
		description: "Disable retry model fallback for this run.",
	});
	pi.registerCommand("fallback", {
		description: "View and manage retry model fallback chains.",
		argumentHint: "[target [fallback1 fallback2 ...]]",
		handler: async (rawArgs, ctx) => handleFallbackCommand(rawArgs, ctx),
	});
}

async function handleFallbackCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const args = rawArgs.trim().split(/\s+/).filter(Boolean);
	if (args.length === 0) {
		const settings = loadFallbackSettings(ctx.sessionSettings);
		await runFallbackMenu(ctx, settings, {
			setChain: (target, entries) => saveChain(ctx, target, entries),
			removeChain: async (target) => {
				await updateFallbackSettings(ctx.sessionSettings, (sessionSettings) =>
					sessionSettings.removeFallbackChain(target),
				);
				ctx.ui.notify(`Removed fallback chain for ${target}.`);
			},
			toggle: async () => {
				await updateFallbackSettings(ctx.sessionSettings, (sessionSettings) =>
					sessionSettings.setModelFallbackEnabled(!settings.modelFallback),
				);
				ctx.ui.notify(`Model fallback ${settings.modelFallback ? "disabled" : "enabled"}.`);
			},
			setRevertPolicy: async (policy) => {
				await updateFallbackSettings(ctx.sessionSettings, (sessionSettings) =>
					sessionSettings.setFallbackRevertPolicy(policy),
				);
				ctx.ui.notify(`Fallback revert policy set to ${policy}.`);
			},
		});
		return;
	}
	if (args.length < 2) {
		ctx.ui.notify("Usage: /fallback <target> <fallback1> [fallback2 ...]", "error");
		return;
	}
	await saveChain(ctx, args[0], args.slice(1));
}

async function saveChain(ctx: ExtensionCommandContext, target: string, entries: string[]): Promise<boolean> {
	const warnings = validateFallbackChains({ [target]: entries }, ctx.modelRegistry);
	if (warnings.length > 0) {
		ctx.ui.notify(warnings.join("\n"), "warning");
		return false;
	}
	await updateFallbackSettings(ctx.sessionSettings, (sessionSettings) =>
		sessionSettings.setFallbackChain(target, entries),
	);
	ctx.ui.notify(`Fallback chain saved for ${target}.`);
	return true;
}

export { isModelFallbackDisabled } from "./settings.ts";
