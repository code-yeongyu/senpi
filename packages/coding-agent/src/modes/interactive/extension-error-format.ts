import { type ExtensionErrorNotice, extensionErrorNoticeLines } from "../../core/extensions/error-notice.ts";
import type { NoticeSpec } from "../../core/extensions/notice/index.ts";

/**
 * Strip terminal control sequences from text that reaches an ANSI-preserving
 * chat row. Error text can carry provider-controlled bytes — a JSON error body
 * may decode `\u001b` escapes into live OSC/CSI sequences — so anything routed
 * to `Text` is sanitized first.
 */
export function sanitizeTuiErrorMessage(value: string): string {
	return value
		.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, "")
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/[ \t\f\v]+/g, " ");
}

export function extensionErrorNoticeSpec(notice: ExtensionErrorNotice): NoticeSpec {
	const lines = extensionErrorNoticeLines(notice);
	const [title = notice.title, why = "", ...extra] = lines;
	return {
		title: sanitizeTuiErrorMessage(title),
		tone: "warning",
		why: sanitizeTuiErrorMessage(why),
		extra: extra.map((text) => ({ text: sanitizeTuiErrorMessage(text) })),
	};
}
