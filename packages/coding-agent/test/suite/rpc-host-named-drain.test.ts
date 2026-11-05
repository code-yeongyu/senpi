import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHostArgs } from "../../src/cli/host-command.ts";
import { stopHost } from "../../src/modes/rpc/host-stop.ts";
import {
	ensureSupervised,
	expectGoneWithin,
	fileAppears,
	generationDir,
	registeredSupervisor,
	removeSupervisedScratches,
	supervisedScratch,
} from "../helpers/rpc-supervised-host.ts";

/**
 * senpi#3653: a NAMED generation can be asked to drain without any signal - the same channel on every
 * platform. The fixture host child ignores SIGUSR1 and leaves only on the file request its supervisor
 * relays, so a generation that exits here was drained through the signal-free path end to end.
 */
afterEach(removeSupervisedScratches, 60_000);

/** The supervisor may advertise before the caller looks. */
async function advertised(path: string): Promise<void> {
	if (!existsSync(path)) await fileAppears(path, 10_000);
}

const NO_STALL_ENV = { SENPI_RPC_LOOP_LAG_ERROR_MS: "600000" };

describe("named generation drain (senpi#3653)", () => {
	it("advertises the drain channel in the generation's own directory", async () => {
		const qa = await supervisedScratch("named-marker");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);
		const marker = join(generationDir(qa, instanceId), "drain-watch.json");

		await advertised(marker);
		expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({ pid });
	}, 45_000);

	it("drains the named generation and reports when it has exited", async () => {
		const qa = await supervisedScratch("named-drain");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid, instanceId } = await registeredSupervisor(qa);
		await advertised(join(generationDir(qa, instanceId), "drain-watch.json"));

		const result = await stopHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			drain: true,
			instanceId,
			waitMs: 20_000,
		});

		expect(result).toEqual({ action: "drained", pid, instanceId, exited: true });
		await expectGoneWithin(pid, 5_000);
		expect(existsSync(generationDir(qa, instanceId))).toBe(false);
	}, 60_000);

	it("refuses a named generation it cannot prove, and sends nothing", async () => {
		const qa = await supervisedScratch("named-unknown");
		await ensureSupervised(qa, { env: NO_STALL_ENV }).then((ensured) => ensured.release());
		const { pid } = await registeredSupervisor(qa);

		const result = await stopHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			drain: true,
			instanceId: "no-such-generation",
		});

		expect(result).toEqual({ action: "refuse", reason: "unknown_owner" });
		expect(() => process.kill(pid, 0)).not.toThrow();
	}, 45_000);
});

describe("host stop --instance (senpi#3653)", () => {
	it("parses a named drain with a bounded wait", () => {
		expect(parseHostArgs(["stop", "--drain", "--instance", "abc", "--wait-ms", "30000"])).toMatchObject({
			subcommand: "stop",
			drain: true,
			instanceId: "abc",
			waitMs: 30_000,
		});
	});

	it("refuses --instance without --drain: a named hard stop is not offered", () => {
		expect(parseHostArgs(["stop", "--instance", "abc"])).toContain("--drain");
	});

	it("refuses a wait that is not a positive integer", () => {
		expect(parseHostArgs(["stop", "--drain", "--instance", "abc", "--wait-ms", "soon"])).toContain("--wait-ms");
	});
});
