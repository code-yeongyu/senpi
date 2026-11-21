import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createLoopHookHost, createReliableTransport } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { handSocketPath } from "../../../src/modes/hand/hand-entry.ts";
import { attachSocketCarrier } from "../../../src/modes/hand/socket-carrier.ts";
import { scratch, spawnRpc, stopChild, waitForStderr } from "../../helpers/rpc-socket-host-support.ts";

// senpi#6756: the real `--hand` is its extensions' home, so it loads them as "hosted-hand" and keeps a handler declared
// `runs: "brain"`; the hosted loop's forwarded input hook reaches it on the hand's machine.
const BRAIN_INPUT_EXTENSION = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default (pi) => {
	const placement = pi.placement;
	pi.on("input", (event) => {
		appendFileSync(join(pi.cwd, "placement-ran.txt"), placement + " " + event.text + "\\n");
	}, { runs: "brain" });
};`;

it("a spawned --hand loads its extensions as hosted-hand and runs a runs: brain input handler", async () => {
	const qa = scratch("s6756h");
	const extension = join(qa.cwd, "..", "brain-input-ext.mjs");
	writeFileSync(extension, BRAIN_INPUT_EXTENSION);
	const agentDir = mkdtempSync(join("/tmp", "s6756h-"));
	const endpoint = handSocketPath(agentDir);
	const child = spawnRpc(["--hand", "--no-skills", "--no-context-files", "-e", extension], qa, undefined, {
		SENPI_CODING_AGENT_DIR: agentDir,
	});
	let socket: Socket | undefined;
	try {
		await waitForStderr(child, `senpi hand: listening on ${endpoint}`);
		const failures: string[] = [];
		const brain = createReliableTransport({
			clock: {
				now: () => Date.now(),
				setTimer: (cb, ms) => {
					const t = setTimeout(cb, ms);
					return () => clearTimeout(t);
				},
			},
			onHandlerError: (error) => {
				failures.push(String(error));
			},
		});
		socket = createConnection(endpoint);
		await new Promise<void>((resolve, reject) => {
			socket?.once("connect", resolve);
			socket?.once("error", reject);
		});
		attachSocketCarrier(socket, brain, () => {});
		const host = createLoopHookHost({ transport: brain, lane: "loop-hooks" });
		const reply = (await host.run("input", {
			inputId: "i6756",
			text: "hello",
			source: "interactive",
			attribution: "user",
			idle: true,
			sessionId: "s6756-session",
			scope: { id: "session-s6756", root: qa.cwd },
		})) as { errors?: unknown[] };

		expect(readFileSync(join(qa.cwd, "placement-ran.txt"), "utf8")).toBe("hosted-hand hello\n");
		expect(reply.errors).toBeUndefined();
		expect(failures).toEqual([]);
		host.close();
		brain.close();
	} finally {
		socket?.destroy();
		await stopChild(child);
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 90_000);
