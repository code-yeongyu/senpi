/**
 * Where a `trash` command exists, deleting a session from the session selector sends the session's sidecars into the
 * trash with its file (senpi#6605, the lead's ruling): its extension state files and its resident blobs. A session
 * restored from the trash must come back whole. Removing them for good while the file is only trashed would lose
 * its goal and its todo list on a restore, and leaving them in the folder gives them to a session of the same id
 * that is moved back later.
 *
 * The `trash` here is a small script on the PATH that moves what it is given into a folder and remembers where each
 * came from, so the delete runs the real command lookup and a real child process.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { deleteSessionFile } from "../../src/modes/interactive/components/session-selector.ts";
import { root, SESSION_ID, writeSession } from "./session-move-fixture.ts";

const onWindows = process.platform === "win32";

const TRASH_SCRIPT = `#!/bin/sh
[ "$1" = "--" ] && shift
status=0
i=0
for path in "$@"; do
	i=$((i + 1))
	case "$path" in
		*.jsonl) ;;
		*) if [ -n "$FAKE_TRASH_REFUSES_SIDECARS" ]; then echo "refused: $path" >&2; status=1; continue; fi ;;
	esac
	mv "$path" "$FAKE_TRASH/$$-$i.item" && printf '%s' "$path" > "$FAKE_TRASH/$$-$i.from"
done
exit $status
`;

afterEach(() => {
	vi.unstubAllEnvs();
});

function aTrashCommand(base: string, options: { readonly refusesSidecars?: boolean } = {}): string {
	const bin = join(base, "bin");
	const trash = join(base, "trash");
	mkdirSync(bin, { recursive: true });
	mkdirSync(trash, { recursive: true });
	writeFileSync(join(bin, "trash"), TRASH_SCRIPT);
	chmodSync(join(bin, "trash"), 0o755);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
	vi.stubEnv("FAKE_TRASH", trash);
	if (options.refusesSidecars) vi.stubEnv("FAKE_TRASH_REFUSES_SIDECARS", "1");
	return trash;
}

const trashed = (trash: string) =>
	readdirSync(trash)
		.filter((name) => name.endsWith(".from"))
		.map((name) => readFileSync(join(trash, name), "utf8"))
		.sort();

function restoreAll(trash: string): void {
	for (const name of readdirSync(trash).filter((entry) => entry.endsWith(".from"))) {
		const from = readFileSync(join(trash, name), "utf8");
		mkdirSync(dirname(from), { recursive: true });
		renameSync(join(trash, name.replace(/\.from$/, ".item")), from);
	}
}

function aSessionWithState() {
	const base = root();
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const file = writeSession(cwd);
	const sessionDir = getDefaultSessionDir(cwd);
	const goal = join(sessionDir, "extensions", "goal", `${SESSION_ID}.json`);
	const todo = join(sessionDir, "extensions", "todo", `${SESSION_ID}.json`);
	const blobs = join(sessionDir, "resident-blobs", SESSION_ID);
	mkdirSync(dirname(todo), { recursive: true });
	writeFileSync(todo, '{"todo":"buy milk"}\n');
	mkdirSync(blobs, { recursive: true });
	writeFileSync(join(blobs, "blob-1"), "a resident blob");
	const read = () => ({
		file: existsSync(file) ? readFileSync(file, "utf8") : "absent",
		goal: existsSync(goal) ? readFileSync(goal, "utf8") : "absent",
		todo: existsSync(todo) ? readFileSync(todo, "utf8") : "absent",
		blob: existsSync(join(blobs, "blob-1")) ? readFileSync(join(blobs, "blob-1"), "utf8") : "absent",
	});
	return { base, file, goal, todo, blobs, read };
}

describe.skipIf(onWindows)("deleting a session where a trash command exists (senpi#6605)", () => {
	it("#given a session with a goal, a todo list and resident blobs #when it is deleted from the selector and then restored from the trash #then its state files and blobs went into the trash with the file, and after the restore the session is whole", async () => {
		const session = aSessionWithState();
		const whole = session.read();
		const trash = aTrashCommand(session.base);

		const result = await deleteSessionFile(session.file);
		const inTheFolder = session.read();
		const inTheTrash = trashed(trash);
		restoreAll(trash);

		expect({ ok: result.ok, method: result.method, inTheFolder, inTheTrash, restored: session.read() }).toEqual({
			ok: true,
			method: "trash",
			inTheFolder: { file: "absent", goal: "absent", todo: "absent", blob: "absent" },
			inTheTrash: [session.file, session.goal, session.todo, session.blobs].sort(),
			restored: whole,
		});
	});

	it("#given a trash command that takes the session file and refuses its sidecars #when the session is deleted #then the sidecars are still in the folder, none was removed for good, and the result names them", async () => {
		const session = aSessionWithState();
		const whole = session.read();
		const trash = aTrashCommand(session.base, { refusesSidecars: true });

		const result = await deleteSessionFile(session.file);

		expect({ ok: result.ok, method: result.method, inTheFolder: session.read(), inTheTrash: trashed(trash) }).toEqual(
			{
				ok: true,
				method: "trash",
				inTheFolder: { ...whole, file: "absent" },
				inTheTrash: [session.file],
			},
		);
		expect(result.sidecarError).toContain(session.goal);
		expect(result.sidecarError).toContain(session.todo);
		expect(result.sidecarError).toContain(session.blobs);
	});
});
