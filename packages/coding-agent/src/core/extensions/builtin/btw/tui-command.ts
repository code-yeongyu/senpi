import { existsSync } from "node:fs";
import { convertToLlm, filterContextExcludedMessages } from "../../../messages.ts";
import type { ExtensionCommandContext } from "../../types.ts";
import { buildBtwPickerOptions, validateBtwPickerChoice } from "./picker.ts";
import { type CreateRetainedBtwSideInput, createRetainedBtwSide } from "./retained-session.ts";
import type { BtwSessionCatalog } from "./session-catalog.ts";
import { loadBtwSessionCatalog } from "./session-catalog.ts";

export interface RunBtwTuiCommandDependencies {
	loadCatalog(ctx: ExtensionCommandContext): Promise<BtwSessionCatalog>;
	createSide(input: CreateRetainedBtwSideInput): Promise<void>;
	buildParentContext(ctx: ExtensionCommandContext, catalog: BtwSessionCatalog): Promise<string>;
	sessionExists(sessionPath: string): Promise<boolean>;
}

const MAX_PARENT_CONTEXT_CHARACTERS = 64_000;

function formatKeyLabel(key: string): string {
	const labels: Record<string, string> = {
		alt: "Alt",
		ctrl: "Ctrl",
		meta: "Meta",
		shift: "Shift",
	};
	return key
		.split("+")
		.map((part) => labels[part] ?? (part.length === 1 ? part.toUpperCase() : part))
		.join("+");
}

function pickerTitle(ctx: ExtensionCommandContext): string {
	const configured = ctx.ui.getKeybindingKeys?.("app.btw.switch") ?? ["ctrl+7"];
	const hints = configured.map(formatKeyLabel);
	return `BTW sessions · /btw · ${hints.join(" · ")}`;
}

export function serializeBtwParentContext(messages: readonly { role: string; content: unknown }[]): string {
	const lines: string[] = [];
	let length = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) continue;
		const line = `${message.role}: ${JSON.stringify(message.content)}`;
		if (length + line.length + 1 > MAX_PARENT_CONTEXT_CHARACTERS) {
			if (lines.length === 0) {
				lines.unshift(line.slice(0, MAX_PARENT_CONTEXT_CHARACTERS));
			}
			break;
		}
		lines.unshift(line);
		length += line.length + 1;
	}
	return lines.join("\n");
}

export const defaultBtwTuiCommandDependencies: RunBtwTuiCommandDependencies = {
	async loadCatalog(ctx) {
		return loadBtwSessionCatalog({
			cwd: ctx.cwd,
			currentSessionPath: ctx.sessionManager.getSessionFile() ?? "",
			listSessions: () => ctx.listSessions(),
			readEntries: async (sessionPath) => ctx.inspectSession(sessionPath).entries,
		});
	},
	createSide: createRetainedBtwSide,
	async buildParentContext(ctx, catalog) {
		const currentSessionPath = ctx.sessionManager.getSessionFile();
		let snapshot: ReturnType<typeof ctx.sessionManager.buildSessionContext>;
		if (currentSessionPath === catalog.parentSessionPath) {
			snapshot = ctx.sessionManager.buildSessionContext();
		} else {
			const parentLeafId = catalog.currentSide?.metadata.parentLeafId;
			snapshot = ctx.inspectSession(catalog.parentSessionPath, { leafId: parentLeafId }).context;
		}
		return serializeBtwParentContext(convertToLlm(filterContextExcludedMessages(snapshot.messages)));
	},
	async sessionExists(sessionPath) {
		return existsSync(sessionPath);
	},
};

export async function runBtwTuiCommand(
	args: string,
	ctx: ExtensionCommandContext,
	dependencies: RunBtwTuiCommandDependencies,
): Promise<void> {
	const currentSessionPath = ctx.sessionManager.getSessionFile();
	if (!currentSessionPath || !(await dependencies.sessionExists(currentSessionPath))) {
		ctx.ui.notify("BTW is unavailable until the current session is saved.", "warning");
		return;
	}
	const question = args.trim();
	if (question) {
		await ctx.waitForIdle();
		const catalog = await dependencies.loadCatalog(ctx);
		await dependencies.createSide({
			ctx,
			catalog,
			question,
			parentContext: await dependencies.buildParentContext(ctx, catalog),
		});
		return;
	}

	while (true) {
		const catalog = await dependencies.loadCatalog(ctx);
		const options = buildBtwPickerOptions(catalog, currentSessionPath);
		if (options.length === 0) {
			ctx.ui.notify("No retained BTW sessions are available.", "warning");
			return;
		}
		const selectedLabel = await ctx.ui.select(
			pickerTitle(ctx),
			options.map((option) => option.label),
		);
		if (selectedLabel === undefined) return;
		const selected = options.find((option) => option.label === selectedLabel);
		if (!selected) return;
		if (!(await validateBtwPickerChoice(selected.choice, dependencies.sessionExists))) {
			ctx.ui.notify("That BTW session no longer exists. Refreshing the list.", "warning");
			continue;
		}
		if (selected.choice.type === "new") {
			await ctx.waitForIdle();
			const settledCatalog = await dependencies.loadCatalog(ctx);
			await dependencies.createSide({
				ctx,
				catalog: settledCatalog,
				question: undefined,
				parentContext: await dependencies.buildParentContext(ctx, settledCatalog),
			});
			return;
		}
		if (selected.choice.sessionPath !== currentSessionPath) {
			await ctx.switchSession(selected.choice.sessionPath);
		}
		return;
	}
}
