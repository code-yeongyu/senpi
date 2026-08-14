import { stripAnsi } from "../../../../utils/ansi.ts";

export function sanitizeBtwDisplayText(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

export function formatBtwQuestion(text: string): string {
	return sanitizeBtwDisplayText(text).replace(/\n+/g, " ").trim();
}
