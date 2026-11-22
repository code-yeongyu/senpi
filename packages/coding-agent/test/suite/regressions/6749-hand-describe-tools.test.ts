import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createLoopHookHost, createReliableTransport } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { handSocketPath } from "../../../src/modes/hand/hand-entry.ts";
import { attachSocketCarrier } from "../../../src/modes/hand/socket-carrier.ts";
import { scratch, spawnRpc, stopChild, waitForStderr } from "../../helpers/rpc-socket-host-support.ts";

interface DescribeToolsReply {
	readonly tools: readonly { readonly name: string; readonly parameters: unknown; readonly sessionBound: boolean }[];
	readonly active: readonly string[];
	readonly evalOnly: readonly string[];
	readonly context: { readonly contextFiles: readonly { readonly path: string; readonly content: string }[] };
}

// senpi#6749: a loop on another machine asks a spawned `--hand` over its socket for the tool list a local session
// there would show its model: eval-only routing applied (the shipped `eval` arms it), the session-state tools marked
// `sessionBound`, and the scope's context files.
it("a spawned --hand answers describe_tools over its socket with its eval-only routing and context files", async () => {
	const qa = scratch("s6749h");
	writeFileSync(join(qa.cwd, "AGENTS.md"), "# Hand project\n\nProbe rule 6749.\n");
	const agentDir = mkdtempSync(join("/tmp", "s6749h-"));
	const endpoint = handSocketPath(agentDir);
	const child = spawnRpc(["--hand", "--no-skills"], qa, undefined, { SENPI_CODING_AGENT_DIR: agentDir });
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
		const reply = (await host.run("describe_tools", {
			sessionId: "s6749-session",
			idle: true,
			scope: { id: "session-s6749", root: qa.cwd },
		})) as unknown as DescribeToolsReply;

		const names = reply.tools.map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining(["read", "bash", "eval"]));
		expect(reply.active).toEqual(expect.arrayContaining(["read", "eval"]));
		expect(reply.active).not.toContain("bash");
		expect(reply.evalOnly).toContain("bash");
		expect(reply.tools.find((tool) => tool.name === "todo")?.sessionBound).toBe(true);
		expect(reply.tools.find((tool) => tool.name === "read")?.sessionBound).toBe(false);
		for (const name of [...reply.active, ...reply.evalOnly]) expect(names).toContain(name);
		expect(reply.context.contextFiles.some((file) => file.content.includes("Probe rule 6749."))).toBe(true);
		expect(failures).toEqual([]);
		host.close();
		brain.close();
	} finally {
		socket?.destroy();
		await stopChild(child);
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 90_000);
