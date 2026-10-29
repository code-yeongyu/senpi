import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const src = fileURLToPath(new URL("../../../src", import.meta.url));
const journal = join(src, "core/session-transcript-journal.ts");

function referenceCount(text: string, name: string): number {
	return (text.match(new RegExp(`(?<!function )\\b${name}\\b`, "g")) ?? []).length;
}

// Part of #4272 (#4347 review LOW-3, RULING-31): readTranscriptRoot and readPersistedBase still read the session file
// synchronously. No production module may call them until they are async; the PR that wires the first production
// reader must make them async and then relax this test.
it("keeps the synchronous transcript readers test-only", () => {
	const stillSync = /\b(?:openSync|readSync|fstatSync)\(/.test(readFileSync(journal, "utf8"));
	expect(stillSync, "the readers became async: relax this guard").toBe(true);
	const offenders: string[] = [];
	for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".ts")) continue;
		const text = readFileSync(join(src, file), "utf8");
		const owner = file === join("modes", "rpc", "accepted-transcript.ts");
		if (referenceCount(text, "readTranscriptRoot") > 0) offenders.push(`${file}: readTranscriptRoot`);
		const journalOwner = file === join("core", "session-transcript-journal.ts");
		if (!owner && !journalOwner && referenceCount(text, "readPersistedBase") > 0) {
			offenders.push(`${file}: readPersistedBase`);
		}
	}
	expect(offenders, "a synchronous transcript reader gained a production caller").toEqual([]);
});
