/**
 * The multi-session host the project verb tests talk to: a scratch project with a project skill (so trust gates it),
 * a faux provider, and records sent through the host's own dispatch on the in-process registry.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

export type WireRecord = Record<string, unknown>;

const LEAN_ARGS = ["--mode", "rpc", "--multi-session", "--no-extensions", "--no-context-files"];

const hosts: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of hosts.splice(0)) await dispose();
	vi.unstubAllEnvs();
});

export async function startHost() {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "senpi-pfv-")));
	const cwd = join(scratch, "project");
	const outside = join(scratch, "outside");
	const agentDir = join(scratch, "agent");
	mkdirSync(join(cwd, CONFIG_DIR_NAME, "skills", "pfv-skill"), { recursive: true });
	mkdirSync(outside);
	mkdirSync(agentDir);
	writeFileSync(
		join(cwd, CONFIG_DIR_NAME, "skills", "pfv-skill", "SKILL.md"),
		"---\nname: pfv-skill\ndescription: Project file verb probe.\n---\nProbe.\n",
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }));
	for (const name of ["SENPI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) vi.stubEnv(name, agentDir);
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false, contextWindow: 128_000 }] });
	const writer = new SessionEventWriter(() => {});
	const answers = new Map<string, (record: WireRecord) => void>();
	writer.registerConnection("client", {
		writeRaw: (line) => {
			const record = JSON.parse(line) as WireRecord;
			if (record.type === "response" && typeof record.id === "string") answers.get(record.id)?.(record);
		},
		waitForBackpressure: async () => {},
	});
	const core = createHostCore(
		{
			agentDir,
			cwd,
			createRuntime: createCliRuntimeFactory(
				{ parsed: parseArgs(LEAN_ARGS), cwd, agentDir, appMode: "rpc" },
				{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
			),
		},
		writer,
		[],
	);
	let serial = 0;
	const send = async (command: WireRecord): Promise<WireRecord> => {
		const id = `pfv-${++serial}`;
		const answer = Promise.withResolvers<WireRecord>();
		answers.set(id, answer.resolve);
		await writer.withConnection("client", () => core.handle(JSON.stringify({ ...command, id })));
		return answer.promise;
	};
	hosts.push(async () => {
		await core.router.dispose();
		writer.unregisterConnection("client");
		rmSync(scratch, { recursive: true, force: true });
	});
	const sessionId = ((await send({ type: "open_session" })).data as { sessionId: string }).sessionId;
	const read = (path: unknown) => send({ type: "read_project_file", sessionId, path });
	const write = (path: unknown, content: unknown, ifEtag: unknown) =>
		send({ type: "write_project_file", sessionId, path, content, ifEtag });
	const trust = () => send({ type: "set_project_trust", sessionId, choice: "trust" });
	return { cwd, outside, sessionId, send, read, write, trust };
}
