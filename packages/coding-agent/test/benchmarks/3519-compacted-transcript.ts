import { readFileSync, writeFileSync } from "node:fs";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Writes a long session file shaped like a real compacted session (senpi#3519): `megabytes` of ordinary
 * small turns, then one compaction that keeps only the last turn. Returns the file path.
 */
export function writeCompactedTranscript(dir: string, megabytes: number): string {
	const seed = SessionManager.create(dir, dir);
	seed.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	const file = seed.getSessionFile();
	if (file === undefined) throw new Error("the seed session has no file");
	const [header, seedLine] = readFileSync(file, "utf8").trim().split("\n");
	if (header === undefined || seedLine === undefined) throw new Error("the seed session file is incomplete");
	const seedEntry = JSON.parse(seedLine);
	const text = "a".repeat(2000);
	const lines = [header];
	let bytes = 0;
	let parentId: string | null = null;
	for (let turn = 0; bytes < megabytes * 1024 * 1024; turn++) {
		const id = turn.toString(16).padStart(8, "0");
		const role = turn % 2 === 0 ? "user" : "assistant";
		const content = role === "user" ? `turn ${turn} ${text}` : [{ type: "text", text: `turn ${turn} ${text}` }];
		const line = JSON.stringify({ ...seedEntry, id, parentId, message: { ...seedEntry.message, role, content } });
		lines.push(line);
		bytes += line.length + 1;
		parentId = id;
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	const writer = SessionManager.open(file, dir);
	const kept = writer.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	writer.appendCompaction("summary of the earlier turns", kept, 1000);
	writer.appendMessage({ role: "user", content: "after the compaction", timestamp: Date.now() });
	return file;
}
