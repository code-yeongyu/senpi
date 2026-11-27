import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const fixture = join(import.meta.dirname, "..", "fixtures", "4565-host-thread-park.ts");
const EVENT_DEADLINE_MS = 10_000;
/** The automount trigger the child's mount view names; not the real /home, which may hold this run's own files. */
const TRIGGER = "/senpi-4565-automount";

interface Child {
	readonly process: ChildProcessWithoutNullStreams;
	next(matches: (line: string) => boolean, label: string): Promise<string>;
}

function start(root: string): Child {
	const child = spawn("bun", [fixture, root, TRIGGER, `${TRIGGER}/someone/omo-runs/run-a`], {
		cwd: join(import.meta.dirname, "..", "..", ".."),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const waiting = new Map<string, { matches: (line: string) => boolean; resolve: (line: string) => void }>();
	const seen: string[] = [];
	createInterface({ input: child.stdout }).on("line", (line) => {
		const entry = [...waiting].find(([, waiter]) => waiter.matches(line));
		if (entry) {
			waiting.delete(entry[0]);
			entry[1].resolve(line);
		} else seen.push(line);
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return {
		process: child,
		next: (matches, label) =>
			new Promise((resolve, reject) => {
				const earlier = seen.findIndex(matches);
				if (earlier >= 0) return resolve(seen.splice(earlier, 1)[0] ?? "");
				const timer = setTimeout(
					() => reject(new Error(`no ${label} from the host thread within ${EVENT_DEADLINE_MS} ms\n${stderr}`)),
					EVENT_DEADLINE_MS,
				);
				waiting.set(label, {
					matches,
					resolve: (line) => {
						clearTimeout(timer);
						resolve(line);
					},
				});
			}),
	};
}

const children: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// senpi#4565: a monitor whose command names a path under an automount trigger was decided by a synchronous
// realpath (decide-target.ts canonicalForCompare) that never returns on a macOS /home whose automounter does not
// answer, so the host stopped accepting connections and its heartbeat stopped. The child's filesystem parks its thread
// in any synchronous call on such a path; the host must still decide, accept and beat.
describe("4565 an automount path in a tool call never parks the host thread", () => {
	it("decides the call, then still accepts a new connection and advances its heartbeat on the virtual clock", async () => {
		// Given a host thread with an accept loop, a heartbeat and a filesystem that parks under the trigger
		const root = mkdtempSync(join(tmpdir(), "senpi-4565-"));
		roots.push(root);
		const child = start(root);
		children.push(child.process);
		const socket = (await child.next((line) => line.startsWith("ready "), "ready")).slice("ready ".length);

		// When it decides a monitor whose command names two paths under the trigger
		child.process.stdin.write("decide\n");
		const decided = child.next((line) => line.startsWith("decided "), "decision");

		// Then the decision completes, a new connection is accepted and the heartbeat advances
		const accepted = child.next((line) => line === "accepted", "accept");
		connect(socket).on("error", () => {});
		child.process.stdin.write("tick\n");
		const beat = child.next((line) => /^beat [1-9]\d*$/.test(line), "heartbeat after the clock moved");
		const events = await Promise.allSettled([decided, accepted, beat]);
		expect(events.map((event) => (event.status === "fulfilled" ? event.value : String(event.reason)))).toEqual([
			expect.stringMatching(/^decided (ask|allow|deny)$/),
			"accepted",
			expect.stringMatching(/^beat [1-9]\d*$/),
		]);
	});
});
