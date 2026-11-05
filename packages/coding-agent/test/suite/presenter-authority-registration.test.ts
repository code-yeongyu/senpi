import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanup,
	discover,
	readOutcome,
	registeringExtension,
	runCli,
	scratch,
	slotModule,
	startHost,
} from "./presenter-authority-registration-support.ts";

// Security contract (D11, senpi#4249): a PresenterAccountAuthority reaches the RPC host only from code the embedding
// distribution runs before main(); main() seals the process-global slot first, so no extension or later code can fill it.

afterEach(cleanup, 60_000);

const HOST_TIMEOUT_MS = 120_000;
const enforcedHost = (socket: string) => [
	"--mode",
	"rpc",
	"--multi-session",
	"--listen",
	`unix://${socket}`,
	"--mcp-presenter-enforcement",
	"--no-skills",
	"--no-context-files",
];

/** Runs one script against the slot module in a fresh process, so every case sees a fresh global. */
async function slotScript(body: string): Promise<unknown> {
	const at = await scratch();
	const file = join(at.root, "slot-case.mjs");
	await writeFile(file, body);
	const run = spawnSync(process.execPath, [file], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`slot script failed (${run.status}):\n${run.stdout}${run.stderr}`);
	return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null");
}

describe("presenter account authority slot", () => {
	it("is first-wins before the seal and refuses every registration after it", async () => {
		const result = await slotScript(`
import { registerPresenterAccountAuthority, takePresenterAccountAuthority } from ${JSON.stringify(slotModule)};
const first = { hostAccount: () => "first" };
const outcome = (fn) => { try { fn(); return "ok"; } catch (error) { return error.message; } };
registerPresenterAccountAuthority(first);
const second = outcome(() => registerPresenterAccountAuthority({ hostAccount: () => "second" }));
const taken = takePresenterAccountAuthority();
const late = outcome(() => registerPresenterAccountAuthority({ hostAccount: () => "late" }));
const again = takePresenterAccountAuthority();
console.log(JSON.stringify({ second, first: taken?.hostAccount(), late, sameOnReread: again === taken }));
`);
		expect(result).toEqual({
			second: "presenter_authority_already_registered",
			first: "first",
			late: "presenter_authority_sealed",
			sameOnReread: true,
		});
	});

	it("is shared by a second instance of the slot module, as the runtime-snapshot hand-off loads one", async () => {
		const result = await slotScript(`
const a = await import(${JSON.stringify(slotModule)});
const b = await import(${JSON.stringify(`${slotModule}?second-instance`)});
a.registerPresenterAccountAuthority({ hostAccount: () => "from-a" });
console.log(JSON.stringify({ distinct: a !== b, seen: b.takePresenterAccountAuthority()?.hostAccount() }));
`);
		expect(result).toEqual({ distinct: true, seen: "from-a" });
	});
});

describe.skipIf(process.platform === "win32")("presenter account authority through the CLI", () => {
	it(
		"an enforced host with no registration answers discover without a control endpoint",
		async () => {
			const at = await scratch();
			await startHost(at, false, [...enforcedHost(at.socket), "--no-extensions"], "senpi rpc listening on");
			const reply = await discover(at.socket, at.cwd);
			expect(reply).toMatchObject({ ok: true });
			expect(reply.context).not.toHaveProperty("controlEndpoint");
		},
		HOST_TIMEOUT_MS,
	);

	it(
		"an enforced host whose embedding entry registered an authority answers discover with its control endpoint",
		async () => {
			const at = await scratch();
			await startHost(at, true, [...enforcedHost(at.socket), "--no-extensions"], "senpi rpc listening on");
			const reply = await discover(at.socket, at.cwd);
			expect(reply).toMatchObject({ ok: true });
			expect(typeof (reply.context as { controlEndpoint?: unknown }).controlEndpoint).toBe("string");
		},
		HOST_TIMEOUT_MS,
	);

	it(
		"an extension cannot register at open_session on an in-process host",
		async () => {
			const at = await scratch();
			const outcome = join(at.root, "open-session-outcome.txt");
			const extension = join(at.root, "registering-extension.mjs");
			await writeFile(extension, registeringExtension(outcome));
			await startHost(at, false, [...enforcedHost(at.socket), "--extension", extension], "senpi rpc listening on");
			const reply = await discover(at.socket, at.cwd);
			expect(await readOutcome(outcome)).toBe("presenter_authority_sealed");
			expect(reply.context).not.toHaveProperty("controlEndpoint");
		},
		HOST_TIMEOUT_MS,
	);

	it(
		"a host child started by a supervisor does not inherit the supervisor's registration",
		async () => {
			const at = await scratch();
			await startHost(
				at,
				true,
				[
					"--internal-rpc-host-supervisor",
					"--socket",
					at.socket,
					"--agent-dir",
					at.agentDir,
					"--mcp-presenter-enforcement",
				],
				"senpi rpc host ready",
			);
			const reply = await discover(at.socket, at.cwd);
			expect(reply).toMatchObject({ ok: true });
			expect(reply.context).not.toHaveProperty("controlEndpoint");
		},
		HOST_TIMEOUT_MS,
	);

	it(
		"an extension cannot register while main() loads it on the list-models path",
		async () => {
			const at = await scratch();
			const outcome = join(at.root, "main-path-outcome.txt");
			const extension = join(at.root, "registering-extension.mjs");
			await writeFile(extension, registeringExtension(outcome));
			const run = await runCli(at, false, ["--list-models", "--extension", extension]);
			expect(await readOutcome(outcome).catch(() => `no outcome (exit ${run.code}):\n${run.output}`)).toBe(
				"presenter_authority_sealed",
			);
		},
		HOST_TIMEOUT_MS,
	);
});
