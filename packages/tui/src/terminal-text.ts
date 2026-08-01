import { homedir } from "node:os";
import type { ImageDimensions } from "./terminal-image.ts";

const TERMINAL_ESCAPE_PATTERN =
	/(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function sanitizeTerminalLabel(value: string): string {
	return value
		.replace(TERMINAL_ESCAPE_PATTERN, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function shortenImagePath(filename: string): string {
	const home = homedir();
	if (home && (filename === home || filename.startsWith(`${home}/`) || filename.startsWith(`${home}\\`))) {
		return `~${filename.slice(home.length)}`;
	}
	return filename;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) {
		const sanitized = sanitizeTerminalLabel(filename);
		parts.push(shortenImagePath(sanitized));
	}
	parts.push(`[${sanitizeTerminalLabel(mimeType)}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
