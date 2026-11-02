import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { forceGc, metadata, percentile } from "../../../tui/bench/_meta.ts";
import { SessionManager, sessionEntryToContextMessages } from "../../src/core/session-manager.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { parseResumeBenchArgs } from "./resume-flow-args.ts";
import { createResumeBenchFixture, type ResumeBenchFixture, removeResumeBenchFixture } from "./resume-flow-fixture.ts";
import { digestRestoredTexts, renderTranscript, TRANSCRIPT_WIDTH } from "./resume-flow-render.ts";

type StageStats = {
	readonly samples: readonly number[];
	readonly medianMs: number;
	readonly p95Ms: number;
};

type IterationMeasurement = {
	readonly discoveryMs: number;
	readonly openMs: number;
	readonly contextMs: number;
	readonly renderMs: number;
	readonly endToEndMs: number;
	readonly eventLoopGapMs: number;
	readonly entryCount: number;
	readonly messageCount: number;
	readonly digest: string;
};

function stageStats(samples: readonly number[]): StageStats {
	return {
		samples,
		medianMs: percentile(samples, 50),
		p95Ms: percentile(samples, 95),
	};
}

async function measureSyncWithEventLoopGap<T>(
	work: () => T,
): Promise<{ readonly value: T; readonly elapsedMs: number; readonly maxGapMs: number }> {
	let maxGap = 0;
	let last = performance.now();
	let active = true;
	const tick = (): void => {
		const now = performance.now();
		const gap = now - last;
		last = now;
		if (gap > maxGap) {
			maxGap = gap;
		}
		if (active) {
			setImmediate(tick);
		}
	};
	await new Promise<void>((resolve) => {
		setImmediate(() => {
			tick();
			resolve();
		});
	});
	const start = performance.now();
	const value = work();
	const elapsedMs = performance.now() - start;
	active = false;
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
	return { value, elapsedMs, maxGapMs: maxGap };
}

async function measureIteration(fixture: ResumeBenchFixture): Promise<IterationMeasurement> {
	const endToEndStart = performance.now();

	const discoveryStart = performance.now();
	const listed = await SessionManager.list(fixture.cwd, fixture.sessionDir);
	const selected = listed.find((session) => session.id === fixture.selectedId);
	if (!selected) {
		throw new Error(`Selected session ${fixture.selectedId} missing from listing`);
	}
	if (listed.length < fixture.decoySessionCount + 1) {
		throw new Error(`Expected at least ${fixture.decoySessionCount + 1} listed sessions, got ${listed.length}`);
	}
	const discoveryMs = performance.now() - discoveryStart;

	const opened = await measureSyncWithEventLoopGap(() => SessionManager.open(selected.path, fixture.sessionDir));
	const session = opened.value;

	const contextStart = performance.now();
	const entries = session.buildContextEntries();
	const messages = entries.flatMap(sessionEntryToContextMessages);
	const contextMs = performance.now() - contextStart;

	const renderStart = performance.now();
	const renderLines = renderTranscript(messages);
	const renderMs = performance.now() - renderStart;
	if (renderLines === 0) {
		throw new Error("Expected transcript output");
	}

	return {
		discoveryMs,
		openMs: opened.elapsedMs,
		contextMs,
		renderMs,
		endToEndMs: performance.now() - endToEndStart,
		eventLoopGapMs: opened.maxGapMs,
		entryCount: session.getEntries().length,
		messageCount: messages.length,
		digest: digestRestoredTexts(messages),
	};
}

export async function runResumeFlowBench(argv: readonly string[]): Promise<void> {
	const args = parseResumeBenchArgs(argv);
	const fixture = await createResumeBenchFixture(args.messages);
	try {
		process.env.HOME = fixture.rootDir;
		process.env.USERPROFILE = fixture.rootDir;
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
		initTheme("dark");

		await measureIteration(fixture);
		forceGc();

		const discoverySamples: number[] = [];
		const openSamples: number[] = [];
		const contextSamples: number[] = [];
		const renderSamples: number[] = [];
		const endToEndSamples: number[] = [];
		const eventLoopGapSamples: number[] = [];
		let digestSha256 = "";
		let restoredEntryCount = 0;
		let restoredMessageCount = 0;
		let eventLoopMaxGapMs = 0;

		for (let iteration = 0; iteration < args.iterations; iteration++) {
			const measured = await measureIteration(fixture);
			discoverySamples.push(measured.discoveryMs);
			openSamples.push(measured.openMs);
			contextSamples.push(measured.contextMs);
			renderSamples.push(measured.renderMs);
			endToEndSamples.push(measured.endToEndMs);
			eventLoopGapSamples.push(measured.eventLoopGapMs);
			eventLoopMaxGapMs = Math.max(eventLoopMaxGapMs, measured.eventLoopGapMs);
			if (iteration === 0) {
				digestSha256 = measured.digest;
				restoredEntryCount = measured.entryCount;
				restoredMessageCount = measured.messageCount;
			} else if (measured.digest !== digestSha256) {
				throw new Error("Restored digest changed across iterations");
			}
		}

		forceGc();
		const report = {
			suite: "resume-flow",
			package: "@code-yeongyu/senpi",
			messages: args.messages,
			iterations: args.iterations,
			fixtureBytes: fixture.fixtureBytes,
			fixtureRoot: fixture.rootDir,
			decoySessionCount: fixture.decoySessionCount,
			transcriptWidth: TRANSCRIPT_WIDTH,
			restoredEntryCount,
			restoredMessageCount,
			digestSha256,
			eventLoopMaxGapMs,
			eventLoopGapSamples,
			endToEndSamples,
			endToEndMedianMs: percentile(endToEndSamples, 50),
			endToEndP95Ms: percentile(endToEndSamples, 95),
			stages: {
				sessionDiscoveryListing: stageStats(discoverySamples),
				sessionOpenParseRestore: stageStats(openSamples),
				buildContextEntries: stageStats(contextSamples),
				transcriptFirstRender: stageStats(renderSamples),
			},
			metadata: metadata(),
		};
		const encoded = JSON.stringify(report);
		if (args.jsonPath) {
			mkdirSync(dirname(args.jsonPath), { recursive: true });
			writeFileSync(args.jsonPath, `${encoded}\n`);
		}
		console.log(encoded);
	} finally {
		removeResumeBenchFixture(fixture);
	}
}
