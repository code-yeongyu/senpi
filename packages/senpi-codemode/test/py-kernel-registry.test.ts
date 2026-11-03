import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import type { CellDecider } from "../src/kernels/js/kernel-contract.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";

const python = await createInterpreterDetector().detect("py");
const rule = { permission: "read", pattern: "subject", layer: "user" };
const decide: CellDecider = () => ({ action: "pass" });

async function harness(active: boolean) {
	if (!python.ok) throw new Error("Python is required for interpreter registry tests");
	const cwd = await mkdtemp(join(tmpdir(), "py-registry-"));
	await writeFile(join(cwd, "subject"), "original");
	const server = await startBridgeServer({
		onCall: async () => null,
		onEmit: async () => {},
		onCompletion: async () => null,
	});
	const kernel = await PythonKernel.start({
		interpreterPath: python.path,
		sessionId: crypto.randomUUID(),
		cwd,
		connection: { port: server.port, token: server.token },
		permissions: { state: () => ({ epoch: 1, active, rules: active ? [rule] : [] }), decide },
	});
	return {
		cwd,
		run: (code: string) => kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 8_000 }),
		close: async () => {
			await kernel.close();
			await server.close();
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

// #4392: CPython's C-level import reads the interpreter's own module dict, not the
// `sys.modules` attribute. Substituting that attribute diverges the two, so modules
// first imported after installation are invisible to C importers (KeyError). The
// kernel interposes on every Python cell, rules or not, hence the no-rules rows.
const registryUsers: readonly (readonly [string, string, string])[] = [
	// `_pickle` resolves `_compat_pickle` through PyImport_Import.
	["pickle", "import pickle\npickle.loads(pickle.dumps({'value': 42}))['value']", "42"],
	// The C `datetime` type imports `_strptime` on the first strptime call.
	["datetime.strptime", "from datetime import datetime\ndatetime.strptime('2020', '%Y').year", "2020"],
	// `xml.etree.ElementTree` reaches `copy` the same way.
	["xml.etree", "import xml.etree.ElementTree as ET\nET.fromstring('<probe/>').tag", "'probe'"],
];

describe.skipIf(!python.ok)("Python interpreter registry integrity", () => {
	it.each(registryUsers)("serves a C-level import with no rules configured: %s", async (_name, code, value) => {
		const h = await harness(false);
		try {
			expect(await h.run(code), code).toMatchObject({ ok: true, valueRepr: value });
		} finally {
			await h.close();
		}
	});

	// An authority refuses loading a *new* extension module outright ("refuses direct
	// extension entry"), so the enforced row uses the one C-level import that needs no
	// extension: the C `datetime` type resolving pure-Python `_strptime`.
	it("serves a C-level import under an active authority", async () => {
		const h = await harness(true);
		try {
			expect(await h.run("from datetime import datetime\ndatetime.strptime('2020', '%Y').year")).toMatchObject({
				ok: true,
				valueRepr: "2020",
			});
		} finally {
			await h.close();
		}
	});

	it("pickles a class from a module first imported in a cell", async () => {
		const h = await harness(false);
		try {
			await writeFile(join(h.cwd, "registry_fixture.py"), "class Payload:\n    value = 42\n");
			expect(
				await h.run(
					"import sys, pickle\nsys.path.insert(0, '.')\nimport registry_fixture\n" +
						"pickle.loads(pickle.dumps(registry_fixture.Payload())).value",
				),
			).toMatchObject({ ok: true, valueRepr: "42" });
		} finally {
			await h.close();
		}
	});

	it("refuses the next decision while a registry entry is swapped", async () => {
		const h = await harness(true);
		try {
			// A base descriptor still reaches the interpreter's own registry, so the
			// guard cannot live on the registry object itself. The decision point
			// re-reads it instead, and refuses before the checked operation runs.
			expect(
				await h.run(
					"import sys, types\nregistry = types.ModuleType.__getattribute__(sys, 'modules')\n" +
						"saved = registry['os']\nregistry['os'] = object()\n" +
						"try:\n    open('subject').read()\nfinally:\n    registry['os'] = saved",
				),
			).toMatchObject({ ok: false, error: { code: "cell_permission_denied", permissionRule: rule } });
			// The refusal is the swap, not a latch: the restored registry decides again.
			expect(await h.run("open('subject').read()")).toMatchObject({ ok: true, valueRepr: "'original'" });
		} finally {
			await h.close();
		}
	});
});
