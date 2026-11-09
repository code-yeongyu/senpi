/**
 * The user message of a spec request: the job's brief, its sampled sources, and on a re-author or
 * retry the spec in place or the rejected answer. Plain template code over a request whose text is
 * already redacted.
 * Ported from oh-my-pi 9df0457b31 `prompts/system/job-widget-user.md` (MIT, Copyright Can Boluk et al.).
 */
import { type JobWidgetPromptSource, buildPromptSources } from "./author-samples.ts";
import { JOB_WIDGET_RESPOND_TOOL } from "./author-system-prompt.ts";
import type { JobWidgetAuthorRequest, JobWidgetBrief } from "./author-types.ts";
import { truncateText } from "./format.ts";

const MAX_BRIEF_CHARS = 1500;
const MAX_REJECTED_ANSWER_CHARS = 4000;

const FENCE = "```";

function excerpt(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? truncateText(trimmed, MAX_BRIEF_CHARS) : undefined;
}

function renderJob(brief: JobWidgetBrief): string[] {
	const out = ["<job>"];
	const command = excerpt(brief.command);
	if (command) out.push("Background bash job. Command:", FENCE, command, FENCE);
	const task = excerpt(brief.task);
	if (task) out.push("Background subagent. Its assignment (excerpt):", FENCE, task, FENCE);
	const intent = excerpt(brief.intent);
	if (intent) out.push(`Why it was started: ${intent}`);
	const watch = excerpt(brief.watch);
	if (watch) out.push(`What the subagent says to watch: ${watch}`);
	const stage = excerpt(brief.stage);
	if (stage) out.push(`Its current stage: ${stage}`);
	out.push("</job>");
	return out;
}

function renderSource(source: JobWidgetPromptSource): string[] {
	const omitted =
		source.omitted > 0
			? ` ${source.omitted} not shown: the middle, and repeats of a line that differ only in numbers.`
			: "";
	const out = [`## \`${source.id}\`: ${source.label}`, `${source.lines} lines so far (${source.size}).${omitted}`];
	out.push(FENCE, ...source.head);
	if (source.tail.length > 0) {
		if (source.omitted > 0) out.push("[…]");
		out.push(...source.tail);
	}
	out.push(FENCE);
	return out;
}

function renderPrevious(previous: NonNullable<JobWidgetAuthorRequest["previous"]>): string[] {
	return [
		"",
		`A spec is already in place, but ${previous.reason}. Write a replacement that matches the lines above:`,
		`${FENCE}json`,
		JSON.stringify(previous.spec),
		FENCE,
	];
}

function renderRejected(rejected: NonNullable<JobWidgetAuthorRequest["rejected"]>): string[] {
	return [
		"",
		"Your previous answer was rejected:",
		`${FENCE}json`,
		truncateText(rejected.answer, MAX_REJECTED_ANSWER_CHARS),
		FENCE,
		"Problems:",
		...rejected.errors.map((error) => `- ${error}`),
		`Fix every problem and call \`${JOB_WIDGET_RESPOND_TOOL}\` again.`,
	];
}

export function renderJobWidgetUserPrompt(request: JobWidgetAuthorRequest): string {
	const lines = [...renderJob(request.brief), "", "<sources>"];
	for (const source of buildPromptSources(request.sources)) lines.push(...renderSource(source));
	lines.push("</sources>");
	if (request.previous) lines.push(...renderPrevious(request.previous));
	if (request.rejected) lines.push(...renderRejected(request.rejected));
	return lines.join("\n");
}
