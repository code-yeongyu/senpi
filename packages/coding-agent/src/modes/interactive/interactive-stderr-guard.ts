import * as fs from "node:fs";
import * as path from "node:path";
import { getDebugLogPath } from "../../config.ts";
import { restoreStderr, takeOverStderr } from "../../core/output-guard.ts";
import { redactSensitiveOutput } from "../../core/sensitive-output.ts";

function appendHiddenInteractiveStderr(text: string): void {
	if (text.length === 0) {
		return;
	}
	const debugLogPath = getDebugLogPath();
	const prefix = `[${new Date().toISOString()}] hidden stderr while TUI active\n`;
	const redactedText = redactSensitiveOutput(text);
	const suffix = redactedText.endsWith("\n") ? "" : "\n";
	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
	fs.appendFileSync(debugLogPath, `${prefix}${redactedText}${suffix}`, { mode: 0o600 });
	fs.chmodSync(debugLogPath, 0o600);
}

export function takeOverInteractiveStderr(): void {
	takeOverStderr(appendHiddenInteractiveStderr, redactSensitiveOutput);
}

export function restoreInteractiveStderr(): void {
	restoreStderr();
}
