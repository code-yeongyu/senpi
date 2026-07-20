import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "../../../thinking-levels.ts";
import type { ExtensionCommandContext } from "../../types.ts";
import type { FallbackSettings } from "./settings.ts";

const MENU = [
	"Show chains & live state",
	"Add/edit chain",
	"Remove chain",
	"Toggle model fallback",
	"Revert policy",
] as const;

export function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function renderFallbackState(ctx: ExtensionCommandContext, settings: FallbackSettings): string {
	const rows = Object.entries(settings.chains).map(([target, entries]) => `${target} -> ${entries.join(", ")}`);
	const chains = rows.length > 0 ? rows.join("\n") : "No fallback chains configured.";
	const status = ctx.sessionSettings.getFallbackStatus();
	const live = status?.active
		? `active on ${status.currentModel ?? "unknown"} from ${status.originalSelector ?? "unknown"}${status.pinned ? " (pinned)" : ""}`
		: "inactive";
	return `${chains}\nModel fallback: ${settings.modelFallback ? "enabled" : "disabled"}\nRevert policy: ${settings.revertPolicy}\nLive retry state: ${live}`;
}

export async function runFallbackMenu(
	ctx: ExtensionCommandContext,
	settings: FallbackSettings,
	actions: {
		setChain(target: string, entries: string[]): Promise<boolean>;
		removeChain(target: string): Promise<void>;
		toggle(): Promise<void>;
		setRevertPolicy(policy: "cooldown-expiry" | "never"): Promise<void>;
	},
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Fallback menu requires interactive UI. Use /fallback <target> <fallback...>.", "error");
		return;
	}
	const choice = await ctx.ui.select("Model fallback", [...MENU]);
	if (!choice) return;
	if (choice === MENU[0]) {
		ctx.ui.notify(renderFallbackState(ctx, settings));
		return;
	}
	if (choice === MENU[1]) {
		await editChain(ctx, actions);
		return;
	}
	if (choice === MENU[2]) {
		const target = await ctx.ui.select("Remove fallback chain", Object.keys(settings.chains));
		if (target) await actions.removeChain(target);
		return;
	}
	if (choice === MENU[3]) {
		await actions.toggle();
		return;
	}
	const policy = await ctx.ui.select("Fallback revert policy", ["cooldown-expiry", "never"]);
	if (policy === "cooldown-expiry" || policy === "never") await actions.setRevertPolicy(policy);
}

async function editChain(
	ctx: ExtensionCommandContext,
	actions: { setChain(target: string, entries: string[]): Promise<boolean> },
): Promise<void> {
	const available = ctx.modelRegistry.getAvailable();
	const target = await ctx.ui.select("Fallback target model", available.map(formatModel));
	if (!target) return;
	const entries: string[] = [];
	while (true) {
		const fallback = await ctx.ui.select("Fallback model (Done to save)", ["Done", ...available.map(formatModel)]);
		if (!fallback || fallback === "Done") break;
		const model = available.find((item) => formatModel(item) === fallback);
		if (!model) return;
		const thinking = await ctx.ui.select("Thinking level", ["inherit", ...getSupportedThinkingLevels(model)]);
		if (!thinking) return;
		entries.push(thinking === "inherit" ? fallback : `${fallback}:${thinking}`);
	}
	if (entries.length > 0) await actions.setChain(target, entries);
}
