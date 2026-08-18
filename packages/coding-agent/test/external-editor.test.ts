import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ExternalEditorResult, editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

const editorFixturePath = fileURLToPath(new URL("./fixtures/fake-external-editor.mjs", import.meta.url));

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
}

async function runExternalEditor(fixtureFlag?: "--fail" | "--empty"): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		// These cases exercise editor-exit behavior. Launch-failure behavior has its own
		// real-OS regression below. Under full-suite subprocess pressure, a transient
		// EAGAIN can prevent the fixture from starting and therefore from writing its
		// capture file, so retry only that distinct pre-launch result.
		let result: ExternalEditorResult;
		let attempts = 0;
		do {
			result = await editInExternalEditor({
				command: `${process.execPath} ${editorFixturePath} ${capturePath}${fixtureFlag ? ` ${fixtureFlag}` : ""}`,
				content: "original",
			});
			attempts += 1;
		} while (result.status === "launch-failed" && attempts < 3);
		if (result.status === "launch-failed") {
			throw new Error(`Editor could not launch after ${attempts} attempts`);
		}
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(/^pi-editor-.+$/);
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.directoryMode & 0o077).toBe(0);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original content when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor("--fail");

		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});
	it("returns empty content when the editor clears the prompt", async () => {
		const { result } = await runExternalEditor("--empty");

		expect(result).toEqual({ status: "complete", content: "" });
	});

	it("reports when the editor cannot launch", async () => {
		const previousComSpec = process.env.ComSpec;
		if (process.platform === "win32") {
			process.env.ComSpec = "Z:\\senpi-missing-command-shell.exe";
		}
		let result: ExternalEditorResult;
		try {
			result = await editInExternalEditor({
				command: join(tmpdir(), "senpi-missing-external-editor"),
				content: "original",
			});
		} finally {
			if (previousComSpec === undefined) {
				delete process.env.ComSpec;
			} else {
				process.env.ComSpec = previousComSpec;
			}
		}

		expect(result).toEqual({ status: "launch-failed" });
	});
});
