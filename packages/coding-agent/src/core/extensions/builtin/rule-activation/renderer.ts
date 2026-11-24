import { noticeEntryRenderer } from "../../notice/index.ts";
import type { EntryRenderer } from "../../types.ts";
import { parseRuleActivationDetails, type RuleActivationDetails } from "./types.ts";

export const renderRuleActivationEntry: EntryRenderer<unknown> = noticeEntryRenderer((entry) => {
	const details = parseRuleActivationDetails(entry.data);
	if (details === undefined) return undefined;
	return { title: titleLine(details), why: summaryLine(details), expandedLine: detailLine(details) };
});

function titleLine(details: RuleActivationDetails): string {
	switch (details.kind) {
		case "project-rules":
			return `● Project rules · ${details.targetPath}`;
		case "ttsr":
			return `⚠ Stream rule · ${details.owner}`;
	}
}

function summaryLine(details: RuleActivationDetails): string {
	switch (details.kind) {
		case "project-rules": {
			const noun = details.rules.length === 1 ? "instruction" : "instructions";
			return `${details.rules.length} ${noun} matched and injected for this tool result.`;
		}
		case "ttsr":
			if (details.remediation !== "nudge") return "Corrupted generation discarded; bounded provider retry started.";
			// repetitive-turns judges a completed reply and never cuts it off (senpi#4537).
			return details.owner === "repetitive-turns"
				? "Reply repeated the previous one; a corrective nudge was queued."
				: "Output interrupted; a corrective nudge was queued.";
	}
}

function detailLine(details: RuleActivationDetails): string {
	switch (details.kind) {
		case "project-rules":
			return details.rules.map((rule) => `rule ${rule}`).join("\n");
		case "ttsr":
			return `remediation ${details.remediation} · observed ${details.rules.join(", ")}`;
	}
}
