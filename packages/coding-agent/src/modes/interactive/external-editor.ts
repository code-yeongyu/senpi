import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripBom } from "../../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult =
	| { status: "complete"; content: string }
	| { status: "failed" }
	| { status: "launch-failed" };

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const [editor, ...editorArgs] = options.command.split(" ");
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		// Keep launch failures distinct from editor failures. Under process pressure,
		// `error` can report EAGAIN before the editor starts; folding that into a
		// nonzero exit makes callers and tests assume editor side effects occurred.
		const outcome = await new Promise<{ launched: false } | { launched: true; code: number | null }>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve({ launched: false }));
			child.on("close", (code) => resolve({ launched: true, code }));
		});

		if (!outcome.launched) {
			return { status: "launch-failed" };
		}
		if (outcome.code !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}

export type EditFileResult = { status: "complete" } | { status: "exited"; code: number } | { status: "launch-failed" };

export async function editFileInExternalEditor(options: { command: string; path: string }): Promise<EditFileResult> {
	const [editor, ...editorArgs] = options.command.split(" ");
	// `close` reports code === null both for a signaled process and (historically)
	// around spawn errors, so the `error` event is the ONLY reliable spawn-failure
	// signal. Anything else means the editor actually launched.
	const outcome = await new Promise<{ launched: false } | { launched: true; code: number | null }>((resolve) => {
		const child = spawn(editor, [...editorArgs, options.path], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", () => resolve({ launched: false }));
		child.on("close", (code) => resolve({ launched: true, code }));
	});

	// The editor never ran, so a freshly seeded file carries no user content and is
	// safe to remove. Once it launched -- nonzero exit or killed by a signal -- it
	// may have written the file, so the caller must keep whatever is on disk.
	if (!outcome.launched) return { status: "launch-failed" };
	if (outcome.code === 0) return { status: "complete" };
	return { status: "exited", code: outcome.code ?? -1 };
}
