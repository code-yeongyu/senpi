import { basename, extname } from "node:path";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStopEvent,
	SessionStopItem,
	SessionStopReport,
} from "../../types.ts";

const STOP_USAGE =
	"Usage: /stop all - end the goal, every monitor (persistent ones included), background shells and child tasks, so nothing resumes or comes back after a restart.";
const LABEL_MAX = 60;

/** `<builtin:goal>` -> `goal`; an extension file path -> its file name without the extension. */
function ownerName(extensionPath: string): string {
	const builtin = /^<[^:>]+:([^>]+)>$/.exec(extensionPath);
	if (builtin?.[1] !== undefined) return builtin[1];
	const file = basename(extensionPath);
	return file.slice(0, file.length - extname(file).length) || extensionPath;
}

function itemText(item: SessionStopItem): string {
	const label = (item.label ?? item.id).replace(/\s+/g, " ").trim();
	const short = label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 3)}...` : label;
	return `${item.kind.replaceAll("_", " ")} "${short}"`;
}

/** The stop's own report: what each owner stopped, then everything that could not be stopped and why. */
export function formatStopReport(report: SessionStopReport): string {
	const stopped = report.owners.filter((owner) => owner.stopped.length > 0);
	const failed = report.owners.flatMap((owner) =>
		owner.failed.map((item) => `- ${ownerName(owner.extensionPath)}: ${itemText(item)}: ${item.reason}`),
	);
	const lines =
		stopped.length === 0
			? ["Stopped: nothing was running."]
			: [
					`Stopped ${stopped.reduce((count, owner) => count + owner.stopped.length, 0)} item(s):`,
					...stopped.map(
						(owner) => `- ${ownerName(owner.extensionPath)}: ${owner.stopped.map(itemText).join(", ")}`,
					),
				];
	if (failed.length > 0) lines.push(`Could not stop ${failed.length} item(s):`, ...failed);
	return lines.join("\n");
}

async function stopSession(ctx: ExtensionContext, requestedBy: SessionStopEvent["requestedBy"]) {
	if (ctx.stopSession === undefined) throw new Error("This host cannot stop a session.");
	return ctx.stopSession(requestedBy);
}

/**
 * One stop for everything a session owns (oh-my-openagent#14390): `/stop all` for a person, `stop_session` for the
 * model (so "do this, then stop" can be obeyed inside a turn). Both emit `session_stop`, which every owner answers.
 */
export default function stopExtension(pi: ExtensionAPI): void {
	pi.registerCommand("stop", {
		description: "Stop everything this session runs: /stop all",
		handler: async (rawArgs, ctx) => {
			if (rawArgs.trim().toLowerCase() !== "all") {
				ctx.ui.notify(STOP_USAGE, "warning");
				return;
			}
			try {
				const report = await stopSession(ctx, "user");
				const failed = report.owners.some((owner) => owner.failed.length > 0);
				ctx.ui.notify(formatStopReport(report), failed ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "stop_session",
		sessionBound: true,
		label: "Stop Session",
		description:
			"Stop everything this session runs, for good: clears the goal, kills every monitor (persistent ones included, so none is restored after a restart), every background shell, and every child task. Use it when the user asked to stop after the current step. Returns what was stopped and what could not be.",
		exposure: "search",
		allowLazyActivation: true,
		searchKeywords: ["stop all", "stop everything", "then stop", "kill all monitors", "clear goal"],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const report = await stopSession(ctx, "agent");
			return { content: [{ type: "text" as const, text: formatStopReport(report) }], details: report };
		},
	});
}
