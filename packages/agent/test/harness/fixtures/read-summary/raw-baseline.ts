import { createReadTool } from "../../../../../coding-agent/src/core/tools/read.ts";

/** The experiment's raw arm uses the real reader, including its existing truncation policy. */
export async function readRawBaseline(cwd: string, path: string): Promise<string> {
	const result = await createReadTool(cwd, {}).execute("raw-baseline", { path });
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
