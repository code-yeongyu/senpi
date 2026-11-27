import { exportFromFile } from "../core/export-html/index.ts";
import { type EngineResult, engineError, engineOk, errorMessage } from "./result.ts";

export interface ExportHtmlInput {
	/** A session file (`.jsonl`). */
	readonly session: string;
	/** The HTML file to write; the engine names it after the session when omitted. */
	readonly out?: string;
}

/** Writes a session file as standalone HTML and answers the path written. */
export async function exportSessionHtml(
	input: ExportHtmlInput,
): Promise<EngineResult<{ readonly path: string }, "export_failed">> {
	try {
		return engineOk({ path: await exportFromFile(input.session, input.out) });
	} catch (error: unknown) {
		return engineError("export_failed", errorMessage(error, "Failed to export session"));
	}
}
