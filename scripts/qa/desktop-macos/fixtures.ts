import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, jxa } from "./observer.ts";

/** Upper bound for an external app to reach a state the driver asked for; exceeding it fails the scenario. */
const SETTLE_DEADLINE_MS = 60_000;
const SETTLE_STEP_MS = 250;

/**
 * Waits for another process (TextEdit, a Terminal tty) to reach `reached`, re-probing it
 * through the observer. There is no event to subscribe to across these process boundaries.
 */
export async function settle<T>(
	what: string,
	probe: () => Promise<T>,
	reached: (value: T) => boolean,
	deadlineMs = SETTLE_DEADLINE_MS,
): Promise<T> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		const value = await probe();
		if (reached(value)) return value;
		if (Date.now() > deadline) throw new Error(`${what} not reached; last=${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, SETTLE_STEP_MS));
	}
}

export const workDir = mkdtempSync(join(tmpdir(), "senpi-qa-desktop-fixtures-"));

/** Open document names; `[]` while TextEdit is not running (an AppleEvent would launch it with restored windows). */
async function textEditDocuments(): Promise<readonly string[]> {
	const names = await jxa(`const t = Application('TextEdit'); JSON.stringify(t.running() ? t.documents.name() : [])`);
	return Array.isArray(names) ? names.map(String) : [];
}

/** Whether LaunchServices still lists TextEdit; `open` fails with -600 until it has noticed the exit. */
const textEditRunning = async () =>
	(await command("/usr/bin/lsappinfo", ["find", "bundleid=com.apple.TextEdit"])).length > 0;

/** Documents opened since TextEdit last ended; anything else on screen is a stray that would skew the counts. */
const opened = new Set<string>();

/**
 * Ends TextEdit, discarding the driver's scratch documents, so window counts start from zero. It is killed:
 * closing documents over AppleScript deadlocked TextEdit inside an NSDocument autosave on this host.
 */
export async function quitTextEdit(): Promise<void> {
	opened.clear();
	// pkill exits 1 when TextEdit is not running; the settle below is the real check.
	await command("/usr/bin/pkill", ["-9", "-x", "TextEdit"]).catch(() => "");
	await settle("TextEdit ended", textEditRunning, (running) => !running);
}

/**
 * Opens a plain-text file in TextEdit without activating it, titled by file name. A launch restores no windows:
 * `-F` plus `ApplePersistenceIgnoreState` for this launch only (the user's defaults are untouched).
 */
export async function openTextEdit(name: string, text: string): Promise<string> {
	const path = join(workDir, name);
	writeFileSync(path, text);
	const fresh = ["--args", "-ApplePersistenceIgnoreState", "YES"];
	await command("/usr/bin/open", ["-g", "-F", "-a", "TextEdit", path, ...fresh]);
	opened.add(name);
	const names = await settle(`TextEdit opened ${name}`, textEditDocuments, (docs) => docs.includes(name));
	const strays = names.filter((doc) => !opened.has(doc));
	if (strays.length > 0) throw new Error(`TextEdit shows documents the driver did not open: ${strays.join(", ")}`);
	return name;
}

/** The document text, read through TextEdit's scripting dictionary (not AX, not the engine). */
export async function textEditText(name: string): Promise<string> {
	return String(await jxa(`JSON.stringify(Application('TextEdit').documents.byName(${JSON.stringify(name)}).text())`));
}

/** The AX selected text range of the document's text area, as System Events reports it. */
export async function textEditSelection(name: string): Promise<unknown> {
	return jxa(`
const w = Application('System Events').processes.byName('TextEdit').windows.byName(${JSON.stringify(name)});
JSON.stringify(w.scrollAreas[0].textAreas[0].attributes.byName('AXSelectedTextRange').value());`);
}

/** A Terminal window reading one line into a file, made the frontmost window of the frontmost app. */
export interface KeySink {
	readonly path: string;
	/** The sink tab's tty, e.g. `ttys012`. */
	readonly tty: string;
	readonly windowId: number;
	read(): string;
}

const sinkWindow = (windowId: number) => `Application('Terminal').windows.byId(${windowId})`;
const sinkBusy = async (windowId: number) =>
	(await jxa(`JSON.stringify(${sinkWindow(windowId)}.tabs[0].busy())`)) === true;

export async function openKeySink(label: string): Promise<KeySink> {
	const path = join(workDir, `${label}-sink.txt`);
	writeFileSync(path, "");
	const tty = await jxa(`
const t = Application('Terminal');
const tab = t.doScript(${JSON.stringify(`head -n 1 > '${path}'; exit`)});
t.activate();
JSON.stringify(tab.tty());`);
	// Completed windows keep the tty name they had, and ttys are reused: only a busy tab on it is the new sink.
	const windowId = await settle(
		"key sink window",
		async () =>
			Number(
				await jxa(`
const tty = ${JSON.stringify(tty)};
const found = Application('Terminal').windows().find((w) => w.tabs().some((c) => c.tty() === tty && c.busy()));
JSON.stringify(found === undefined ? 0 : found.id());`),
			),
		(id) => id > 0,
	);
	const frontmost = () =>
		jxa(`JSON.stringify(Application('System Events').processes.whose({ frontmost: true })[0].name())`);
	await settle("key sink frontmost", frontmost, (app) => app === "Terminal");
	return { path, tty: String(tty).replace("/dev/", ""), windowId, read: () => readFileSync(path, "utf8") };
}

/** Ends the sink's `head` if its line never arrived, waits for its shell to exit, and closes its window. */
export async function closeKeySink(sink: KeySink): Promise<void> {
	// While the tab is busy it still owns the tty, so only its own `head` can match there.
	if (await sinkBusy(sink.windowId)) {
		const listed = await command("/bin/ps", ["-t", sink.tty, "-o", "pid=,comm="]);
		const heads = listed.split("\n").flatMap((line) => {
			const [pid, comm] = line.trim().split(/\s+/);
			return comm === "head" && pid !== undefined ? [pid] : [];
		});
		if (heads.length > 0) await command("/bin/kill", heads);
	}
	await settle(
		"key sink shell exited",
		() => sinkBusy(sink.windowId),
		(busy) => !busy,
	);
	await jxa(`${sinkWindow(sink.windowId)}.close(); '"ok"'`);
}

/** Counts the distinct canary dialogs (`osascript` processes showing the canary marker) while it runs. */
export interface DialogCounter {
	stop(): Promise<readonly number[]>;
}

const COUNT_DIALOGS = (stopFile: string) => `
ObjC.import('Foundation');
const se = Application('System Events');
// Excludes this osascript: its main thread is busy here, so querying its own windows would stall every pass.
const others = se.processes.whose({ _and: [{ name: 'osascript' }, { _not: [{ unixId: $.NSProcessInfo.processInfo.processIdentifier }] }] });
const seen = {};
console.log('ready');
while (!$.NSFileManager.defaultManager.fileExistsAtPath(${JSON.stringify(stopFile)})) {
	try {
		const pids = others.unixId();
		const texts = others.windows.staticTexts.value();
		pids.forEach((pid, index) => {
			if (JSON.stringify(texts[index] || []).includes('senpi desktop canary')) seen[pid] = true;
		});
	} catch (error) {
		// A dialog that closed between the two queries; the next pass sees the settled list.
	}
}
JSON.stringify(Object.keys(seen).map(Number));
`;

export async function countCanaryDialogs(): Promise<DialogCounter> {
	const stopFile = join(workDir, `canary-stop-${Date.now()}`);
	const child: ChildProcess = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", COUNT_DIALOGS(stopFile)]);
	let stdout = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	await new Promise<void>((resolve, reject) => {
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			if (chunk.includes("ready")) resolve();
		});
		child.once("close", () => reject(new Error("canary dialog counter exited before it was ready")));
	});
	return {
		async stop() {
			writeFileSync(stopFile, "");
			await exited;
			const pids: unknown = JSON.parse(stdout.trim());
			return Array.isArray(pids) ? pids.map(Number) : [];
		},
	};
}
