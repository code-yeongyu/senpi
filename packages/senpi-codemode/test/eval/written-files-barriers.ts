import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import { SOURCE_FILE_SNIFF_BYTES } from "../../src/written-files/source-file.ts";
import {
	type FakeWorkspace,
	type ReportedResult,
	reportedPaths,
	type WrittenFilesHarness,
	writtenFilesHarness,
} from "./written-files-fakes.ts";

type ReportOutcome = Awaited<ReturnType<ExtensionToolContext["reportToolResult"]>>;
type CellOutcome = Awaited<ReturnType<ReturnType<WrittenFilesHarness["writtenFiles"]["open"]>["settle"]>>;

/** A promise a test opens by hand: every pause in these tests waits on one, never on time. */
export interface Gate {
	readonly opened: Promise<void>;
	open(): void;
}

export function gate(): Gate {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/**
 * Holds the next read of the given kind open until `finish`: the source sniff while the settlement selects, or the
 * read back just before a hook would start. The other kind passes.
 */
export function holdRead(workspace: FakeWorkspace, kind: "sniff" | "readBack") {
	const reading = gate();
	const finished = gate();
	workspace.afterRead = async (_path, limit) => {
		const sniffing = limit <= SOURCE_FILE_SNIFF_BYTES;
		if (sniffing !== (kind === "sniff")) return;
		workspace.afterRead = undefined;
		reading.open();
		await finished.opened;
	};
	return { reading: reading.opened, finish: finished.open };
}

export function outcomeFiles(outcome: CellOutcome) {
	return outcome?.kind === "written"
		? { files: outcome.report.files, total: outcome.report.total, hooked: outcome.report.hooked }
		: outcome;
}

export function hookFailures(outcome: CellOutcome): readonly string[] {
	return outcome?.kind === "written" ? outcome.report.hookFailures.map((failure) => failure.path) : [];
}

export function hooksReturn(harness: WrittenFilesHarness): ReportOutcome {
	return { toolCallId: `cell/reported-${harness.reported.length}`, result: undefined, failures: [] };
}

export async function openCell(harness: WrittenFilesHarness) {
	const cell = harness.writtenFiles.open(harness.ctx);
	await cell.ready;
	return cell;
}

/**
 * One round of a claim ending with its hook. Cell A lists `first` and `second`; a formatter rewrites each file the
 * first time its hook runs. The hook for `first` then ends as `endFirst` says; the hook for `second` pauses. During that
 * pause cell B settles (the rewrite of `first` must be A's, and `second` is still A's), then `first` is edited and cell
 * B2 settles (A must have let go of `first`). After A settles, cell C settles (the rewrite of `second` must be A's),
 * then `second` is edited and cell C2 settles (A must have let go of it).
 */
export async function claimRound(
	first: string,
	second: string,
	endFirst: (harness: WrittenFilesHarness) => Promise<ReportOutcome>,
	prepare: (workspace: FakeWorkspace) => void = () => {},
) {
	const paused = gate();
	const resume = gate();
	const seen = new Set<unknown>();
	const harness: WrittenFilesHarness = writtenFilesHarness(async (report: ReportedResult) => {
		const path = report.input.path;
		if (seen.has(path)) return hooksReturn(harness);
		seen.add(path);
		const { workspace } = harness;
		if (path === workspace.absolute(first)) {
			workspace.write(first, "export const first = 1;\n");
			return await endFirst(harness);
		}
		workspace.write(second, "export const second = 1;\n");
		paused.open();
		await resume.opened;
		return hooksReturn(harness);
	});
	const { workspace } = harness;
	const signal = new AbortController().signal;
	const [cellA, cellB, cellB2] = [await openCell(harness), await openCell(harness), await openCell(harness)];
	workspace.write(first, "export const first=1\n");
	workspace.write(second, "export const second=1\n");
	prepare(workspace);

	const settlingA = cellA.settle(signal);
	await paused.opened;
	const pausedB = await cellB.settle(signal);
	workspace.write(first, "export const edited = 1;\n");
	const pausedB2 = await cellB2.settle(signal);
	resume.open();
	const outcomeA = await settlingA;
	const cellC = await openCell(harness);
	const afterC = await cellC.settle(signal);
	workspace.write(second, "export const edited = 2;\n");
	const cellC2 = await openCell(harness);
	const afterC2 = await cellC2.settle(signal);
	for (const cell of [cellA, cellB, cellB2, cellC, cellC2]) cell.close();

	return {
		a: outcomeFiles(outcomeA),
		failures: hookFailures(outcomeA),
		paused: [outcomeFiles(pausedB), outcomeFiles(pausedB2)],
		after: [outcomeFiles(afterC), outcomeFiles(afterC2)],
		hooked: reportedPaths(harness),
	};
}

/** What {@link claimRound} returns when A's claim on each file ends exactly when that file's hook does. */
export function claimRoundExpected(first: string, second: string) {
	return {
		paused: [undefined, { files: [first], total: 1, hooked: 1 }],
		after: [undefined, { files: [second], total: 1, hooked: 1 }],
	};
}
