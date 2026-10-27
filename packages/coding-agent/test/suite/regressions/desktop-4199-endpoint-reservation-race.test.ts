import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { openEndpointReservationStore } from "../../../src/modes/rpc/endpoint-reservation-store.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2a step 2, test 10).
// Security contract: the role claim is an atomic compare-and-set across processes. Claimants that all read the same
// offered nonce and are released at once yield exactly one `claimed`; every other one is refused.
const CLAIMANTS = 8;
const ENDPOINT = "C:\\Users\\u\\.senpi\\agent\\rpc\\rpc.sock";
const fixture = resolve(import.meta.dirname, "../../fixtures/reservation-claimant.ts");

describe("reservation claim across processes", () => {
	const roots: string[] = [];
	const children: ChildProcess[] = [];

	afterEach(async () => {
		for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	it("lets exactly one of several processes released together claim the role", async () => {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-race-"));
		roots.push(root);
		const storePath = join(root, "endpoint.reservation.db");
		const store = await openEndpointReservationStore(storePath);
		const generation = store.reserve(
			ENDPOINT,
			"owner",
			["supervisor", "host"],
			{
				root: { status: "presence_unavailable", reason: "unsupported_platform", detail: null },
				ownerKernelSession: { status: "unverified", reason: "unsupported_platform" },
			},
			{ status: "presence_unavailable" },
		);
		store.offer(generation, "supervisor", "owner", { status: "presence_unavailable" });
		store.close();

		const outcomes: Promise<string>[] = [];
		const ready: Promise<void>[] = [];
		for (let index = 0; index < CLAIMANTS; index++) {
			const child = spawn(
				process.execPath,
				["--import", import.meta.resolve("tsx"), fixture, storePath, ENDPOINT, generation, `participant-${index}`],
				{ stdio: ["pipe", "pipe", "inherit"] },
			);
			children.push(child);
			const { stdout } = child;
			if (stdout === null) throw new Error("claimant has no stdout pipe");
			const lines = createInterface({ input: stdout });
			ready.push(
				new Promise((settle) => {
					lines.on("line", (line) => {
						if (line === "READY") settle();
					});
				}),
			);
			outcomes.push(
				new Promise((settle) => {
					lines.on("line", (line) => {
						if (line.startsWith("OUTCOME ")) settle(line.slice("OUTCOME ".length));
					});
				}),
			);
		}
		await Promise.all(ready);
		for (const child of children) child.stdin?.write("go\n");
		const results = await Promise.all(outcomes);
		await Promise.all(children.map((child) => (child.exitCode === null ? once(child, "exit") : undefined)));

		expect(results.filter((outcome) => outcome === "claimed")).toHaveLength(1);
		for (const outcome of results.filter((value) => value !== "claimed")) {
			expect(["role_already_claimed", "store_busy"]).toContain(outcome);
		}
	}, 60_000);
});
