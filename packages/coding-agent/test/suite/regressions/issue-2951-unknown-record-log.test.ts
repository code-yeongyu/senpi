import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it.each([
	{
		records: ["host.pid"],
		identity: "legacy timestamp unavailable",
		check: "provenOwner(registered, socket)",
		values: [null, null],
	},
	{ records: ["host.pid"], identity: null, check: "provenOwner(registered, socket)", values: [null, null] },
	{
		records: ["session-path-claim"],
		identity: "legacy timestamp unavailable",
		check: "claimOwnerIsLive(owner)",
		values: [true, true],
	},
	{ records: ["session-path-claim"], identity: null, check: "claimOwnerIsLive(owner)", values: [true, true] },
	{
		records: ["host.pid", "session-path-claim"],
		identity: "legacy timestamp unavailable",
		check: "[await provenOwner(registered, socket), await claimOwnerIsLive(owner)]",
		values: [
			[null, true],
			[null, true],
		],
	},
])(
	"logs $records once for repeated unknown live identity checks ($identity)",
	async ({ records, identity, check, values }) => {
		const root = await mkdtemp(join(tmpdir(), "held-unknown-record-"));
		try {
			const registration = new URL("../../../src/modes/rpc/host-daemon-registration.ts", import.meta.url).href;
			const reservations = new URL("../../../src/modes/rpc/host-reservations.ts", import.meta.url).href;
			const source = `
			import { provenOwner } from ${JSON.stringify(registration)};
			import { claimOwnerIsLive } from ${JSON.stringify(reservations)};
			const socket = ${JSON.stringify(join(root, "rpc.sock"))};
			const owner = { instanceId: "unknown-log", pid: process.pid, processStartTime: ${JSON.stringify(identity)}, sessionPath: socket };
			const registered = { record: owner, socket, instanceId: owner.instanceId, generation: 0 };
			const values = [await ${check}, await ${check}];
			console.log(JSON.stringify({ pid: process.pid, values }));
		`;
			const result = await run(process.execPath, ["--input-type=module", "-e", source], {
				encoding: "utf8",
				timeout: 20_000,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					TMPDIR: root,
					SENPI_CODING_AGENT_DIR: join(root, "agent"),
				},
			});
			const output = JSON.parse(result.stdout);
			expect(output.values).toEqual(values);
			expect(
				result.stderr
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line)),
			).toEqual(records.map((record) => ({ event: "legacy_host_identity_unknown", record, pid: output.pid })));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("keeps the diagnostic budget separate for distinct pids in one caller process", async () => {
	const root = await mkdtemp(join(tmpdir(), "held-unknown-pids-"));
	try {
		const logger = new URL("../../../src/modes/rpc/host-supervisor-log.ts", import.meta.url).href;
		const source = `
			import { logUnknownHostIdentity } from ${JSON.stringify(logger)};
			for (const pid of [process.pid, process.ppid, process.pid, process.ppid]) logUnknownHostIdentity("host.pid", pid);
			console.log(JSON.stringify([process.pid, process.ppid]));
		`;
		const result = await run(process.execPath, ["--input-type=module", "-e", source], {
			encoding: "utf8",
			timeout: 20_000,
			env: { PATH: process.env.PATH, HOME: root, SENPI_CODING_AGENT_DIR: join(root, "agent") },
		});
		const pids: readonly number[] = JSON.parse(result.stdout);
		expect(
			result.stderr
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual(pids.map((pid) => ({ event: "legacy_host_identity_unknown", record: "host.pid", pid })));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
