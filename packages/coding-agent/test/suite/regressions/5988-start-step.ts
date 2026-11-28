// senpi#5988: one ordinary CLI start in its own process, split at the two points the issue names.
//   1. startup admission, the real `createSessionManager` path of `senpi --session <file>` (it exits with
//      SESSION_HELD_EXIT_CODE when another live process holds the session);
//   2. publication of this process's holder record, the real `holdSessionFile`.
// In the CLI, extension and model loading run between the two. Here a line on stdin stands in for that loading,
// so the parent test decides the interleaving and no step is ordered by time. A closed stdin ends the start the way
// a quitting CLI does. `failLoad` makes the loading fail: the start exits instead of holding the session.
import { createInterface } from "node:readline";
import { parseArgs } from "../../../src/cli/args.ts";
import { foreignSessionHolders } from "../../../src/core/foreign-session-holders.ts";
import { holdSessionFile, type SessionHold, SessionHeldError } from "../../../src/core/session-holders.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";

const { root, file, id, failLoad } = JSON.parse(process.argv[2] ?? "{}") as {
	root: string;
	file: string;
	id: string;
	failLoad?: boolean;
};

let hold: SessionHold | undefined;
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const nextLine = async (): Promise<string> => {
	const next = await lines.next();
	if (next.done !== true) return next.value;
	hold?.release();
	process.exit(0);
};
const report = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};

await createSessionManager(parseArgs(["--session", file]), root, root, SettingsManager.inMemory(), "print");
report({ step: "admitted", pid: process.pid });

await nextLine();
if (failLoad === true) process.exit(1);
try {
	hold = await holdSessionFile(file, id, { cwd: root, expectExisting: true });
} catch (error) {
	if (!(error instanceof SessionHeldError)) throw error;
	report({ step: "refused at hold", pid: process.pid, holders: error.holders.map((holder) => holder.pid) });
	process.exit(0);
}
report({ step: "holding", pid: process.pid });

await nextLine();
report({ step: "sees", pid: process.pid, others: (await foreignSessionHolders(file, id)).map((holder) => holder.pid) });

await nextLine();
hold.release();
process.exit(0);
