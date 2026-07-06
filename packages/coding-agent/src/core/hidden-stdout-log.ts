import * as fs from "node:fs";
import * as path from "node:path";
import { getDebugLogPath } from "../config.ts";
import { redactSensitiveOutput } from "./sensitive-output.ts";

export function appendHiddenTuiStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	const debugLogPath = getDebugLogPath();
	const prefix = `[${new Date().toISOString()}] hidden stdout while TUI active\n`;
	const redactedText = redactSensitiveOutput(text);
	const suffix = redactedText.endsWith("\n") ? "" : "\n";
	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
	fs.appendFileSync(debugLogPath, `${prefix}${redactedText}${suffix}`, { mode: 0o600 });
	fs.chmodSync(debugLogPath, 0o600);
}
