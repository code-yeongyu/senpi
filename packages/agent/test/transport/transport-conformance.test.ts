// senpi#4738 (Z2.LANE, Z2.FAIR.S05, QX2.S05): the TRANSPORT, MULTI-LANE/FAIR and FAULT-TRANSPORT conformance cases on
// the in-process reference transport, through the suite runner.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildManifest, findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { type CaseImplementation, type HostReport, runSuite } from "../../src/conformance/runner.ts";
import { createReliableTransport, decodeReferencePacket } from "../../src/transport/reliable-transport.ts";
import { FAULT_TRANSPORT_CASES } from "../../src/transport/testing/fault-cases.ts";
import { FAULT_PROFILE_NAMES } from "../../src/transport/testing/fault-transport.ts";
import { MULTI_CASES } from "../../src/transport/testing/multi-cases.ts";
import { TRANSPORT_CASES } from "../../src/transport/testing/transport-cases.ts";
import type {
	TransportCaseAdapters,
	TransportConformanceAdapter,
} from "../../src/transport/testing/transport-harness.ts";
import type { FrameHandler, TransportSide } from "../../src/transport/transport.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const readRepoFile = async (path: string): Promise<Uint8Array> => readFile(`${REPO_ROOT}${path}`);

const IMPLEMENTATIONS = new Map<string, CaseImplementation<TransportCaseAdapters>>([
	...TRANSPORT_CASES,
	...MULTI_CASES,
	...FAULT_TRANSPORT_CASES,
]);
const TRANSPORT_REGISTRY = CONFORMANCE_REGISTRY.filter((entry) =>
	/^(TRANSPORT-|MULTI-LANE-|MULTI-FAIR-0[12]$|FAULT-TRANSPORT-)/.test(entry.id),
);
const TRANSPORT_IDS = ["TRANSPORT-01", "TRANSPORT-02", "TRANSPORT-03"];
const MULTI_IDS = ["MULTI-LANE-01", "MULTI-FAIR-01", "MULTI-FAIR-02"];
const FAULT_IDS = ["01", "02", "03", "04", "05"].map((n) => `FAULT-TRANSPORT-${n}`);
const ALL_IDS = [...TRANSPORT_IDS, ...MULTI_IDS, ...FAULT_IDS];

type SideShape = (side: TransportSide) => TransportSide;

function referenceAdapter(shape?: SideShape): TransportConformanceAdapter {
	return {
		createSide: (clock) => {
			const side = createReliableTransport({
				clock,
				window: 8,
				retransmitMs: 200,
				onHandlerError: (error) => {
					throw error;
				},
			});
			return shape === undefined ? side : shape(side);
		},
		decode: decodeReferencePacket,
	};
}

function withHandler(wrapHandler: (handler: FrameHandler) => FrameHandler): SideShape {
	return (side) => ({
		send: (lane, payload) => side.send(lane, payload),
		onFrame: (handler) => side.onFrame(wrapHandler(handler)),
		inFlight: (lane) => side.inFlight(lane),
		close: () => side.close(),
		attached: (connection) => side.attached(connection),
		message: (message) => side.message(message),
		writable: () => side.writable(),
		detached: () => side.detached(),
	});
}

async function runOnReference(shape?: SideShape): Promise<HostReport> {
	const manifest = await buildManifest(TRANSPORT_REGISTRY, readRepoFile);
	return runSuite(
		manifest,
		{
			name: "reference",
			provides: ["transport"],
			adapters: { transport: referenceAdapter(shape), platform: "linux" },
		},
		IMPLEMENTATIONS,
	);
}

describe("the TRANSPORT, MULTI-LANE/FAIR and FAULT-TRANSPORT registration", () => {
	it("registers every case with its implementation file, each needing a transport", () => {
		const testing = "packages/agent/src/transport/testing";
		expect(TRANSPORT_REGISTRY.map((entry) => [entry.id, entry.impl, entry.adapters])).toEqual([
			...TRANSPORT_IDS.map((id) => [id, `${testing}/transport-cases.ts`, ["transport"]]),
			...MULTI_IDS.map((id) => [id, `${testing}/multi-cases.ts`, ["transport"]]),
			...FAULT_IDS.map((id) => [id, `${testing}/fault-cases.ts`, ["transport"]]),
		]);
	});

	it("has an implementation for every registered case and a registered case for every implementation", () => {
		expect(findImplementationGaps(TRANSPORT_REGISTRY, IMPLEMENTATIONS)).toEqual({
			unimplemented: [],
			unregistered: [],
		});
	});

	it("has one FAULT-TRANSPORT case per fault profile", () => {
		expect(FAULT_PROFILE_NAMES).toEqual(["slow", "lossy", "laggy", "flap", "drop-reattach"]);
		expect([...FAULT_TRANSPORT_CASES.keys()]).toEqual(FAULT_IDS);
	});
});

describe("the reference transport over the in-process carrier", () => {
	let report: HostReport;
	beforeAll(async () => {
		report = await runOnReference();
	});

	for (const id of ALL_IDS) {
		it(`passes ${id}`, () => {
			expect(report.results.find((result) => result.id === id)).toEqual({ id, status: "pass" });
		});
	}
});

describe("the cases fail a transport that breaks the contract", () => {
	const rows: ReadonlyArray<{ name: string; shape: () => SideShape; failing: string[] }> = [
		{
			name: "delivers every frame twice",
			shape: () =>
				withHandler((handler) => async (frame) => {
					await handler(frame);
					await handler(frame);
				}),
			failing: ALL_IDS,
		},
		{
			name: "runs every lane's deliveries on one shared line",
			shape: () =>
				withHandler((handler) => {
					let line: Promise<void> = Promise.resolve();
					return (frame) => {
						const run = line.then(() => handler(frame));
						line = run;
						return run;
					};
				}),
			failing: ["MULTI-FAIR-01"],
		},
	];

	for (const row of rows) {
		it(`fails exactly the cases that observe a transport that ${row.name}`, async () => {
			const failed = (await runOnReference(row.shape())).results
				.filter((result) => result.status === "fail")
				.map((result) => result.id);
			expect(failed).toEqual(row.failing);
		});
	}
});
