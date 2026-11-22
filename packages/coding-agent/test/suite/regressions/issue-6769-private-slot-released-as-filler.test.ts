import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeStartupHandOff } from "../../../src/modes/rpc/host-startup-wire.ts";
import { releaseStartupFillers, withStartupPipe } from "../../../src/private-fd-startup-fillers.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";

const child = join(import.meta.dirname, "..", "..", "fixtures", "private-fd-capture-before-filler-release-child.ts");
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const PRIVATE_SLOT = 5;

function text(stream: unknown): Promise<string> {
	if (!(stream instanceof Readable)) throw new Error("missing a piped stream");
	let collected = "";
	stream.on("data", (chunk: Buffer) => {
		collected += String(chunk);
	});
	return new Promise((resolveText, reject) => {
		stream.once("close", () => resolveText(collected));
		stream.once("error", reject);
	});
}

// A supervisor builds its host child's stdio with the startup pipe and fillers first (withStartupPipe), then
// spawnWithPrivateFds places each private descriptor at its own number, so the hand-off still lists that slot as a
// filler. The child evaluates the capture before the release, as the bundled CLI entry does.
describe.skipIf(process.platform === "win32" || !bunAvailable)(
	"senpi#6769: a private slot the hand-off lists as a filler",
	() => {
		it("survives a filler release that evaluates after the capture, so the claimed channel still carries data", async () => {
			const { stdio, fillers } = withStartupPipe<"ignore" | "pipe">(["ignore", "pipe", "pipe"]);
			expect(fillers).toContain(PRIVATE_SLOT);
			stdio[PRIVATE_SLOT] = "pipe";
			const run = spawn("bun", [child], {
				env: {
					...hostSpawnEnv(),
					SENPI_PRIVATE_FDS: JSON.stringify({ "memory-sync": PRIVATE_SLOT }),
					SENPI_PRIVATE_FDS_FINAL: "1",
					SENPI_RPC_HOST_STARTUP_EVENTS: encodeStartupHandOff({
						binding: {
							attempt: "9".repeat(32),
							endpoint: "/fixture.sock",
							instanceId: "fixture",
							generation: 0,
							launchKind: "initial",
							predecessor: null,
						},
						role: "host",
						budgetMs: 180_000,
						fillers,
					}),
				},
				stdio,
			});
			const exited = once(run, "close", { signal: AbortSignal.timeout(45_000) });
			const report = text(run.stdout);
			const errors = text(run.stderr);
			const pipes: readonly unknown[] = run.stdio;
			const received = text(pipes[PRIVATE_SLOT]);
			releaseStartupFillers(
				run,
				fillers.filter((slot) => slot !== PRIVATE_SLOT),
			);
			const [code] = await exited;
			expect(code, await errors).toBe(0);
			expect(await report).toBe("written\n");
			expect(await received).toBe("child-ok\n");
		}, 60_000);
	},
);
