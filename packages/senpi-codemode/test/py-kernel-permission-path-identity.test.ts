import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { createIdentityDecider, type RecordedCall } from "./fixtures/path-identity.ts";

// Design 6.3.3 (#4392): a Python cell sends the path as written plus the string the operation hands
// to the OS (`executedPath`, the cwd-joined spelling for a relative path, never collapsed), and its
// native canonical form when available. Every row names ONE file through the rule's spelling and
// the request's spelling and asserts that an active deny refuses the operation while an inactive
// kernel passes it.
const python = await createInterpreterDetector().detect("py");
const darwin = process.platform === "darwin";

function sameEntry(a: string, b: string): boolean {
	try {
		const x = lstatSync(a, { bigint: true });
		const y = lstatSync(b, { bigint: true });
		return x.dev === y.dev && x.ino === y.ino;
	} catch {
		return false;
	}
}

type Pair = { readonly name: string; readonly rule: string; readonly request: string };
type Op = readonly [name: string, code: (request: string) => string];

const readOps: Op[] = [
	["open r", (q) => `open(${JSON.stringify(q)}).read()`],
	["Path.read_text", (q) => `Path(${JSON.stringify(q)}).read_text()`],
	["os.open O_RDONLY", (q) => `fd = os.open(${JSON.stringify(q)}, os.O_RDONLY); os.close(fd)`],
];
const writeOps: Op[] = [
	["open w", (q) => `open(${JSON.stringify(q)}, 'w').write('CHANGED')`],
	["Path.write_text", (q) => `Path(${JSON.stringify(q)}).write_text('CHANGED')`],
	[
		"os.open O_WRONLY",
		(q) => `fd = os.open(${JSON.stringify(q)}, os.O_WRONLY | os.O_TRUNC); os.write(fd, b'CHANGED'); os.close(fd)`,
	],
];
const listOps: Op[] = [
	["os.listdir", (q) => `os.listdir(${JSON.stringify(q)})`],
	["os.listdir fd", (q) => `fd = os.open(${JSON.stringify(q)}, os.O_RDONLY); os.listdir(fd); os.close(fd)`],
];

describe.each([true, false])("Python path identity: active=%s", (active) => {
	let root: string;
	let real: string;
	let pairs: Pair[];
	const denied = new Set<string>();
	const calls: RecordedCall[] = [];
	let kernel: PythonKernel;
	let server: Awaited<ReturnType<typeof startBridgeServer>>;
	const run = (code: string) =>
		kernel.run({
			cellId: crypto.randomUUID(),
			code: `import os\nfrom pathlib import Path\n${code}`,
			timeoutMs: 20_000,
		});
	const refused = (result: Awaited<ReturnType<typeof run>>) =>
		!result.ok && result.error?.code === "cell_permission_denied";

	beforeAll(async () => {
		if (!python.ok) throw new Error("Python is required for permission enforcement tests");
		root = mkdtempSync(join(tmpdir(), "py-path-identity-"));
		real = realpathSync.native(root);
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "real", "secret"), "SECRET");
		symlinkSync(join(root, "real"), join(root, "link"));
		symlinkSync(join(root, "real", "secret"), join(root, "flink"));
		const caseAlias = join(root, "REAL", "secret");
		const nfc = darwin ? join(root, "real", "caf\u00e9.txt") : undefined;
		const nfd = darwin ? join(root, "real", "cafe\u0301.txt") : undefined;
		if (nfc) writeFileSync(nfc, "SECRET");
		pairs = [
			{ name: "real x link", rule: `${real}/real/secret`, request: join(root, "link", "secret") },
			{ name: "link x real", rule: join(root, "link", "secret"), request: `${real}/real/secret` },
			{ name: "link x flink", rule: join(root, "link", "secret"), request: join(root, "flink") },
			{ name: "flink x real", rule: join(root, "flink"), request: `${real}/real/secret` },
			{ name: "real x relative link", rule: `${real}/real/secret`, request: "link/secret" },
			{ name: "real x relative link/../secret", rule: `${real}/real/secret`, request: "link/../real/secret" },
			...(sameEntry(caseAlias, join(root, "real", "secret"))
				? [{ name: "case alias x real", rule: caseAlias, request: `${real}/real/secret` }]
				: []),
			...(nfc && nfd ? [{ name: "NFC x NFD", rule: nfc, request: nfd }] : []),
		];
		server = await startBridgeServer({
			onCall: async () => null,
			onEmit: async () => {},
			onCompletion: async () => null,
		});
		kernel = await PythonKernel.start({
			interpreterPath: python.path,
			sessionId: crypto.randomUUID(),
			cwd: root,
			connection: { port: server.port, token: server.token },
			memory: { gcWatermarkBytes: 0, noticeBytes: 0, ceilingBytes: 0 },
			permissions: {
				state: () => ({ epoch: 1, active, rules: [{ permission: "read", pattern: "boundary", layer: "user" }] }),
				decide: createIdentityDecider(denied, calls),
			},
		});
	}, 60_000);

	afterAll(async () => {
		await kernel?.close();
		await server?.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("decides reads and writes by file identity across spellings", async () => {
		for (const pair of pairs) {
			denied.clear();
			denied.add(pair.rule);
			for (const [op, code] of readOps) {
				const result = await run(code(pair.request));
				expect(refused(result), `${pair.name} / ${op}: ${JSON.stringify(result)}`).toBe(active);
			}
			const target = isAbsolute(pair.request) ? pair.request : join(root, pair.request);
			for (const [op, code] of writeOps) {
				writeFileSync(target, "SECRET");
				const result = await run(code(pair.request));
				expect(refused(result), `${pair.name} / ${op}: ${JSON.stringify(result)}`).toBe(active);
				expect(readFileSync(target, "utf8"), `${pair.name} / ${op} effect`).toBe(active ? "SECRET" : "CHANGED");
				writeFileSync(target, "SECRET");
			}
		}
	}, 120_000);

	it("decides directory listings by identity, through a path and through a directory descriptor", async () => {
		denied.clear();
		denied.add(`${real}/real`);
		for (const request of ["link", join(root, "link")]) {
			for (const [op, code] of listOps) {
				const result = await run(code(request));
				expect(refused(result), `${request} / ${op}: ${JSON.stringify(result)}`).toBe(active);
			}
		}
	}, 60_000);

	it.runIf(active)(
		"sends the written and executed spellings with the native canonical identity",
		async () => {
			denied.clear();
			denied.add(`${real}/real/secret`);
			for (const written of [join(root, "link", "secret"), "link/secret", "link/../real/secret", "./link/secret"]) {
				calls.length = 0;
				await run(`try:\n    open(${JSON.stringify(written)}).read()\nexcept Exception:\n    pass`);
				const seen = calls.find((call) => call.path === written);
				expect(seen, `decider never received ${written}: ${JSON.stringify(calls)}`).toBeDefined();
				// os.path.join on os.getcwd(): anchored to the interpreter's physical cwd and never collapsed.
				expect(seen?.executedPath).toBe(isAbsolute(written) ? written : `${real}/${written}`);
				expect(seen?.canonical).toBe(realpathSync.native(join(real, "real", "secret")));
				expect(seen?.unresolvable).toBeUndefined();
			}
		},
		60_000,
	);

	it.runIf(active)(
		"anchors the executed spelling to the interpreter's current directory",
		async () => {
			denied.clear();
			denied.add(`${real}/real/secret`);
			calls.length = 0;
			const result = await run(
				`saved = os.getcwd()\nos.chdir('link')\ntry:\n    open('secret').read()\nfinally:\n    os.chdir(saved)`,
			);
			expect(refused(result), JSON.stringify(result)).toBe(true);
			expect(calls.find((call) => call.path === "secret")?.executedPath).toBe(`${real}/real/secret`);
		},
		60_000,
	);

	it("refuses a spelling that is not valid UTF-8 as uncheckable instead of sending a lossy string", async () => {
		denied.clear();
		calls.length = 0;
		const result = await run("open(b'subject-\\xff').read()");
		if (active) {
			expect(refused(result), JSON.stringify(result)).toBe(true);
			expect(!result.ok && result.error?.message).toMatch(/cannot be checked/u);
			expect(calls.filter((call) => call.path?.startsWith("subject-"))).toEqual([]);
		} else {
			expect(result).toMatchObject({ ok: false, error: { name: "FileNotFoundError" } });
		}
	}, 60_000);
});
