/**
 * The multi-session host the folder MCP and skill-file verb tests (senpi#6485) drive: the host's own dispatch on the
 * in-process registry with a faux provider. The project carries a project skill, so trust gates it, and `prepare`
 * lays out files (links, a stored mcp.json, extra skills) before the session opens and lists its skills.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

export type WireRecord = Record<string, unknown>;

export interface FolderLayout {
	readonly cwd: string;
	readonly outside: string;
	readonly agentDir: string;
}

export interface FolderHost extends FolderLayout {
	readonly sessionId: string;
	send(command: WireRecord): Promise<WireRecord>;
	call(type: string, fields?: WireRecord): Promise<WireRecord>;
	trust(): Promise<WireRecord>;
}

const LEAN_ARGS = ["--mode", "rpc", "--multi-session", "--no-extensions", "--no-context-files"];

export const SKILL_NAME = "pfv-skill";
export const PROJECT_CONFIG_DIR = CONFIG_DIR_NAME;

export function skillSource(name: string, body = "Probe."): string {
	return `---\nname: ${name}\ndescription: Folder verb probe.\n---\n${body}\n`;
}

const disposers: Array<() => Promise<void>> = [];

export async function disposeFolderHosts(): Promise<void> {
	for (const dispose of disposers.splice(0)) await dispose();
	vi.unstubAllEnvs();
}

export async function startFolderHost(
	options: {
		readonly settings?: WireRecord;
		readonly prepare?: (layout: FolderLayout) => void;
	} = {},
): Promise<FolderHost> {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "senpi-pfm-")));
	const layout: FolderLayout = {
		cwd: join(scratch, "project"),
		outside: join(scratch, "outside"),
		agentDir: join(scratch, "agent"),
	};
	const { cwd, agentDir } = layout;
	mkdirSync(join(cwd, CONFIG_DIR_NAME, "skills", SKILL_NAME), { recursive: true });
	mkdirSync(layout.outside);
	mkdirSync(agentDir);
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "skills", SKILL_NAME, "SKILL.md"), skillSource(SKILL_NAME));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", ...options.settings }),
	);
	options.prepare?.(layout);
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
		const id = `pfm-${++serial}`;
		const answer = Promise.withResolvers<WireRecord>();
		answers.set(id, answer.resolve);
		await writer.withConnection("client", () => core.handle(JSON.stringify({ ...command, id })));
		return answer.promise;
	};
	disposers.push(async () => {
		await core.router.dispose();
		writer.unregisterConnection("client");
		rmSync(scratch, { recursive: true, force: true });
	});
	const sessionId = ((await send({ type: "open_session" })).data as { sessionId: string }).sessionId;
	const call = (type: string, fields: WireRecord = {}) => send({ type, sessionId, ...fields });
	return { ...layout, sessionId, send, call, trust: () => call("set_project_trust", { choice: "trust" }) };
}
