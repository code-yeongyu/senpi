import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEBVIEW_WARM_UP_DIR_ENV } from "./webview-fixtures.ts";

// Vitest runs this once in its main process before any test file starts, so every file's process sees the
// same directory: the WebView warm-ups take their turns through it (senpi#7147).
export default function setup(): () => void {
	const directory = mkdtempSync(join(tmpdir(), "senpi-webview-warm-up-"));
	process.env[WEBVIEW_WARM_UP_DIR_ENV] = directory;
	return () => {
		delete process.env[WEBVIEW_WARM_UP_DIR_ENV];
		rmSync(directory, { recursive: true, force: true });
	};
}
