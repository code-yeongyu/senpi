import { chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { type Win32OpenFileErrorCode, Win32SimFs } from "../../../agent/src/testing/win32-sim.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../scripts/vitest-temp.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ProjectionFiles, ProjectionWarning } from "../../src/core/session-store/durable-binding.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

let root: string;
let dir: string;
let medium: MemoryStoreMedium;

beforeEach(async () => {
	root = makeTempDir(path.join(tmpdir(), "s20-win32-"));
	dir = path.join(root, "C", "sessions");
	medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
});

afterEach(() => {
	chmodSync(root, 0o755);
});

/** The binding's async replace on the shared win32 profile: write a temp file, then rename it over the target. */
function win32Files(sim: Win32SimFs): ProjectionFiles {
	return {
		async replace(target, contents) {
			const temp = `${win32PathOf(target)}.tmp`;
			await sim.writeFile(temp, contents);
			await sim.rename(temp, win32PathOf(target));
		},
	};
}

async function boundSession(files: ProjectionFiles) {
	const session = SessionManager.create(dir, dir);
	const warnings: ProjectionWarning[] = [];
	session.onProjectionWarning((warning) => warnings.push(warning));
	await session.bindDurableStore({ store: openMemoryStore(medium), epoch: 1, files });
	return { session, warnings };
}

const win32PathOf = (posix: string): string => {
	const relative = path.relative(root, posix).split(path.sep);
	return `${relative[0]}:\\${relative.slice(1).join("\\")}`;
};

describe.each<Win32OpenFileErrorCode>(["EPERM", "EBUSY"])(
	"a durable session's reprojection on the win32 profile (rename of an open file: %s)",
	(renameOpenFileError) => {
		it("keeps the stale mark and the file unchanged while a reader holds the file, then reprojects byte-identically", async () => {
			const sim = new Win32SimFs({ root, renameOpenFileError });
			const { session, warnings } = await boundSession(win32Files(sim));
			session.appendMessage(userMsg("question"));
			const file = session.getSessionFile() ?? "";
			chmodSync(file, 0o444);
			session.appendMessage(assistantMsg("lost append"));
			chmodSync(file, 0o644);
			const reader = await sim.open(win32PathOf(file));
			const held = readFileSync(file, "utf8");

			session.appendCustomEntry("note", { while: "held" });
			await session.settleDurableProjection();

			expect(warnings.map((warning) => warning.code)).toEqual(["EACCES", renameOpenFileError]);
			expect(readFileSync(file, "utf8")).toBe(held);

			await reader.close();
			session.appendCustomEntry("note", { after: "released" });
			await session.settleDurableProjection();

			expect(warnings).toHaveLength(2);
			expect(SessionManager.open(file, dir).getEntries()).toEqual(session.getEntries());
		});
	},
);
