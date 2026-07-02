import { Text } from "../src/components/text.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "../test/virtual-terminal.ts";
import { makeTranscript, percentiles } from "./frame-fixture.ts";

declare const process: {
	readonly argv: readonly string[];
};

const COLUMNS = 80;
const ROWS = 40;
const WARMUP_FRAMES = 30;
const MEASURED_FRAMES = 300;
const DEFAULT_TRANSCRIPT_LINES = 10_000;

export interface FrameCostResult {
	readonly n: number;
	readonly stableComponents: boolean;
	readonly frames: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly bytesPerFrameP50: number;
	readonly initialBytes: number;
	readonly renderCalls: number;
	readonly transcriptRenderCalls: number;
}

export interface FrameCostOptions {
	readonly stableComponents?: boolean;
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];
	private lastWriteAt: number | undefined;

	override write(data: string): void {
		this.writes.push(data);
		this.lastWriteAt = performance.now();
		super.write(data);
	}

	getWriteBytes(): number {
		return new TextEncoder().encode(this.writes.join("")).byteLength;
	}

	clearWrites(): void {
		this.writes = [];
		this.lastWriteAt = undefined;
	}

	getWriteElapsed(start: number): number | undefined {
		return this.lastWriteAt === undefined ? undefined : this.lastWriteAt - start;
	}
}

class MeasuredStatusText extends Text {
	private measured = false;
	renderCalls = 0;

	setMeasured(measured: boolean): void {
		this.measured = measured;
	}

	override render(width: number): string[] {
		if (this.measured) {
			this.renderCalls += 1;
		}
		return super.render(width);
	}
}

class MeasuredTranscriptText extends Text {
	private readonly stableComponents: boolean;
	private measured = false;
	private stableLines: string[] | undefined;
	renderCalls = 0;

	constructor(text: string, paddingX: number, paddingY: number, stableComponents: boolean) {
		super(text, paddingX, paddingY);
		this.stableComponents = stableComponents;
	}

	setMeasured(measured: boolean): void {
		this.measured = measured;
	}

	override render(width: number): string[] {
		if (this.stableComponents && this.stableLines) {
			return this.stableLines;
		}
		this.invalidate();
		const lines = super.render(width);
		if (this.measured) {
			this.renderCalls += 1;
		}
		if (this.stableComponents) {
			this.stableLines = lines;
		}
		return lines;
	}
}

function readN(defaultN: number): number {
	const index = process.argv.indexOf("--n");
	if (index === -1) return defaultN;
	const raw = process.argv[index + 1];
	const parsed = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : defaultN;
}

function readStableComponents(): boolean {
	return process.argv.includes("--stable-components");
}

async function runFrame(tui: TUI, status: Text, terminal: LoggingVirtualTerminal, frame: number): Promise<number> {
	terminal.clearWrites();
	status.setText(`status frame ${String(frame).padStart(3, "0")}`);
	const start = performance.now();
	tui.requestRender();
	return new Promise<number>((resolve) => {
		queueMicrotask(async () => {
			await terminal.waitForRender();
			resolve(terminal.getWriteElapsed(start) ?? performance.now() - start);
		});
	});
}

export async function runFrameCost(n: number, options: FrameCostOptions = {}): Promise<FrameCostResult> {
	const stableComponents = options.stableComponents === true;
	const terminal = new LoggingVirtualTerminal(COLUMNS, ROWS);
	const tui = new TUI(terminal);
	const transcript = new MeasuredTranscriptText(makeTranscript(n).join("\n"), 0, 0, stableComponents);
	const status = new MeasuredStatusText("status frame initial", 0, 0);
	tui.addChild(transcript);
	tui.addChild(status);

	try {
		tui.start();
		await terminal.waitForRender();
		const initialBytes = terminal.getWriteBytes();

		for (let frame = 0; frame < WARMUP_FRAMES; frame++) {
			await runFrame(tui, status, terminal, frame);
		}

		const frameTimes: number[] = [];
		const frameBytes: number[] = [];
		status.renderCalls = 0;
		transcript.renderCalls = 0;
		status.setMeasured(true);
		transcript.setMeasured(true);
		for (let frame = 0; frame < MEASURED_FRAMES; frame++) {
			frameTimes.push(await runFrame(tui, status, terminal, frame));
			frameBytes.push(terminal.getWriteBytes());
		}
		status.setMeasured(false);
		transcript.setMeasured(false);

		const timeSummary = percentiles(frameTimes);
		const byteSummary = percentiles(frameBytes);
		return {
			n: Math.max(0, Math.floor(n)),
			stableComponents,
			frames: MEASURED_FRAMES,
			p50Ms: timeSummary.p50,
			p95Ms: timeSummary.p95,
			bytesPerFrameP50: byteSummary.p50,
			initialBytes,
			renderCalls: status.renderCalls,
			transcriptRenderCalls: transcript.renderCalls,
		};
	} finally {
		tui.stop();
	}
}

async function main(): Promise<void> {
	const result = await runFrameCost(readN(DEFAULT_TRANSCRIPT_LINES), { stableComponents: readStableComponents() });
	console.log(JSON.stringify(result));
}

if (/(^|[/\\])frame-cost\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
	await main();
}
