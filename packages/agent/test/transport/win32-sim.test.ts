// senpi#4738 (QX1.win.S05): TRANSPORT-01..03 under Windows endpoint naming (named pipes, no file mode) keep order and
// resume. Windows behavior is simulated in code, never on a VM.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { runSuite } from "../../src/conformance/runner.ts";
import { createInProcessNetwork } from "../../src/transport/in-process-carrier.ts";
import { localEndpoint } from "../../src/transport/local-endpoint.ts";
import { createReliableTransport, decodeReferencePacket } from "../../src/transport/reliable-transport.ts";
import { TRANSPORT_CASES } from "../../src/transport/testing/transport-cases.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const readRepoFile = async (path: string): Promise<Uint8Array> => readFile(`${REPO_ROOT}${path}`);
const WIN32_PIPE_PREFIX = "\\\\.\\pipe\\";
const WIN32_TEMP = "C:\\Users\\test\\AppData\\Local\\Temp";

const side = () =>
	createReliableTransport({
		clock: { now: () => 0, setTimer: () => () => {} },
		onHandlerError: (error) => {
			throw error;
		},
	});

describe("local endpoints under the win32 profile", () => {
	it("names a Windows endpoint as a named pipe with no file mode, independent of the socket directory", () => {
		expect(localEndpoint("win32", "senpi-lanes", WIN32_TEMP)).toEqual({
			kind: "named-pipe",
			address: `${WIN32_PIPE_PREFIX}senpi-lanes`,
		});
		expect(localEndpoint("win32", "senpi-lanes", "D:\\other")).toEqual(
			localEndpoint("win32", "senpi-lanes", WIN32_TEMP),
		);
	});

	it("names a POSIX endpoint as an owner-only Unix socket in the socket directory", () => {
		expect(localEndpoint("linux", "senpi-lanes", "/run/senpi")).toEqual({
			kind: "unix-socket",
			address: "/run/senpi/senpi-lanes.sock",
			mode: 0o600,
		});
	});

	it("refuses names that are empty or carry a path separator on either platform", () => {
		for (const name of ["", "a\\b", "a/b"]) {
			expect(() => localEndpoint("win32", name, WIN32_TEMP)).toThrow(RangeError);
			expect(() => localEndpoint("darwin", name, "/tmp")).toThrow(RangeError);
		}
	});

	it("reaches a named pipe whatever the case of its name, as Windows does, and keeps Unix socket names exact", () => {
		const network = createInProcessNetwork();
		network.listen(localEndpoint("win32", "Senpi-Lanes", WIN32_TEMP), side());
		const upper = localEndpoint("win32", "SENPI-LANES", WIN32_TEMP);
		expect(() => network.dial({ kind: "named-pipe", address: upper.address.toUpperCase() }, side())).not.toThrow();

		network.listen(localEndpoint("linux", "Senpi-Lanes", "/run/senpi"), side());
		expect(() => network.dial(localEndpoint("linux", "senpi-lanes", "/run/senpi"), side())).toThrow(/no listener/);
	});
});

describe("TRANSPORT-01..03 on named-pipe endpoints", () => {
	it("keeps order, resumes and applies backpressure over a named pipe", async () => {
		const registry = CONFORMANCE_REGISTRY.filter((entry) => /^TRANSPORT-0[1-3]$/.test(entry.id));
		const manifest = await buildManifest(registry, readRepoFile);
		const report = await runSuite(
			manifest,
			{
				name: "reference-win32",
				provides: ["transport"],
				adapters: {
					platform: "win32",
					transport: {
						createSide: (clock) =>
							createReliableTransport({
								clock,
								window: 8,
								retransmitMs: 200,
								onHandlerError: (error) => {
									throw error;
								},
							}),
						decode: decodeReferencePacket,
					},
				},
			},
			TRANSPORT_CASES,
		);
		expect(report.results).toEqual(
			["TRANSPORT-01", "TRANSPORT-02", "TRANSPORT-03"].map((id) => ({ id, status: "pass" })),
		);
	});
});
