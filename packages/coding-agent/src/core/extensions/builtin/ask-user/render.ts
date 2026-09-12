import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../types.ts";

export const renderCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme) => {
	const values = typeof args === "object" && args !== null ? args : {};
	const headers =
		"questions" in values && Array.isArray(values.questions)
			? values.questions
					.map((q: unknown) =>
						typeof q === "object" && q !== null && "header" in q ? `[${q.header}]` : "[Question]",
					)
					.join(" ")
			: "Question";
	const wait =
		("waitForAnswer" in values && values.waitForAnswer === true) ||
		("wait_for_answer" in values && values.wait_for_answer === true);
	return new Text(`${theme.fg("toolTitle", headers)} ${wait ? "wait for answer" : "answer later"}`, 0, 0);
};
export const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result) => {
	const details: unknown = result.details;
	let summary = "";
	if (typeof details === "object" && details !== null && "status" in details) {
		summary = String(details.status);
		if ("answers" in details && typeof details.answers === "object" && details.answers !== null)
			summary += `; ${Object.keys(details.answers).length} answered`;
		if ("unanswered" in details && Array.isArray(details.unanswered))
			summary += `; ${details.unanswered.length} unanswered`;
	}
	return new Text(
		[summary, ...result.content.flatMap((c) => (c.type === "text" ? [c.text] : []))].filter(Boolean).join("\n"),
		0,
		0,
	);
};
