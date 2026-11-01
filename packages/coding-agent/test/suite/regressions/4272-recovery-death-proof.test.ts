import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { currentRootOwner } from "../../../src/modes/rpc/compact-root-owner.ts";
import { sweepRecoveryRoots } from "../../../src/modes/rpc/compact-recovery-cleanup.ts";

const probe = vi.hoisted(() => ({ absent: false }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const execFile = (...args: unknown[]) => {
		if (!probe.absent || args[0] !== "ps") return Reflect.apply(actual.execFile, undefined, args);
		const callback = args.at(-1);
		if (typeof callback !== "function") throw new Error("expected ps callback");
		queueMicrotask(() => callback(Object.assign(new Error("ps absent"), { code: 1 }), "", ""));
		return new EventEmitter();
	};
	const custom = Symbol.for("nodejs.util.promisify.custom");
	Object.defineProperty(execFile, custom, { value: Reflect.get(actual.execFile, custom) });
	return { ...actual, execFile };
});

let base = "";
afterEach(async () => {
	probe.absent = false;
	vi.restoreAllMocks();
	if (base) await rm(base, { recursive: true, force: true });
});

// #4272 S14 L4/RULING-87: a failed process query cannot authorize deleting a live owner's bytes; only kill(pid, 0)
// answering ESRCH proves death (EPERM means the process exists). The check lives in the root-owner proof, so the
// shared process-identity probe and the host supervisor keep their behaviour.
it.each(["exists", "EPERM", "ESRCH"] as const)(
	"requires ESRCH when ps reports absent but kill answers %s",
	async (kill) => {
		const owner = await currentRootOwner();
		if (!owner) throw new Error("fixture needs a provable POSIX owner");
		base = await mkdtemp(join(tmpdir(), "s14-death-"));
		const dir = join(base, "senpi-current-owner");
		await mkdir(dir, { mode: 0o700 });
		await writeFile(join(dir, ".compact-spool-owner"), JSON.stringify({ kind: "scratch", token: "test", owner }), {
			mode: 0o600,
		});
		probe.absent = true;
		const signal = vi.spyOn(process, "kill").mockImplementation(() => {
			if (kill !== "exists") throw Object.assign(new Error(kill), { code: kill });
			return true;
		});

		const result = await sweepRecoveryRoots(base);

		expect(result.removed).toBe(kill === "ESRCH" ? 1 : 0);
		expect(signal).toHaveBeenCalledWith(owner.pid, 0);
	},
);
