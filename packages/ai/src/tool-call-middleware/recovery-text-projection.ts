import type { AssistantMessage, Tool } from "../types.ts";
import { createAntmlInvokeRecoveryStreamParser } from "./protocols/antml/recovery-stream.ts";
import { createRecoveryCodeMask, type RecoveryCodeMaskSegment } from "./recovery-code-mask.ts";
import { appendRecoveryDiagnostic } from "./recovery-diagnostics.ts";
import type { RecoveryNativeProjection } from "./recovery-native-projection.ts";
import type { StreamMessageProjection } from "./stream-wrapper-shared.ts";
import type { StreamParserEvent } from "./types.ts";

/** Owns one ordinary assistant text block's mask/parser/projection lifecycle. */
export class RecoveryTextProjection {
	private readonly projection: StreamMessageProjection;
	private readonly nativeProjection: RecoveryNativeProjection;
	private readonly innerIndex: number;
	private readonly parser: ReturnType<typeof createAntmlInvokeRecoveryStreamParser>;
	private readonly mask = createRecoveryCodeMask();
	private activeInvoke = false;
	private textBuffer = "";
	private sawToolCall = false;
	private finished = false;

	constructor(
		tools: readonly Tool[],
		projection: StreamMessageProjection,
		nativeProjection: RecoveryNativeProjection,
		innerIndex: number,
	) {
		this.projection = projection;
		this.nativeProjection = nativeProjection;
		this.innerIndex = innerIndex;
		this.parser = createAntmlInvokeRecoveryStreamParser(tools);
	}

	start(source: AssistantMessage): boolean {
		const outerIndex = this.projection.startText(this.innerIndex, source.content[this.innerIndex]);
		return this.nativeProjection.startText(this.innerIndex, outerIndex);
	}

	feed(text: string): boolean {
		for (let index = 0; index < text.length; index += 1) {
			const character = text.charAt(index);
			const options = this.activeInvoke ? { activeInvoke: true } : undefined;
			for (const segment of this.mask.feed(character, options)) this.processSegment(segment);
		}
		this.flushText();
		return this.sawToolCall;
	}

	finish(): boolean {
		if (this.finished) return this.sawToolCall;
		for (const segment of this.mask.finish()) this.processSegment(segment);
		this.projectParserEvents(this.parser.finish());
		this.flushText();
		this.projection.finishText();
		this.nativeProjection.extendText(this.innerIndex);
		this.finished = true;
		return this.sawToolCall;
	}

	private processSegment(segment: RecoveryCodeMaskSegment): void {
		if (segment.recoveryBoundary) this.projectParserEvents(this.parser.interrupt());
		if (segment.scan) this.projectParserEvents(this.parser.feed(segment.text));
		else this.textBuffer += segment.text;
	}

	private projectParserEvents(events: readonly StreamParserEvent[]): void {
		for (const event of this.nativeProjection.assignRecoveredIds(events)) {
			if (event.type === "text") {
				this.textBuffer += event.text;
				continue;
			}
			this.flushText();
			const result = this.projection.projectParserEvents([event]);
			this.sawToolCall = this.sawToolCall || result.sawToolCall;
			if (event.type === "toolcall_start") this.activeInvoke = true;
			if (event.type === "toolcall_end") {
				this.activeInvoke = false;
				for (const toolCall of result.completedToolCalls) appendRecoveryDiagnostic(this.projection, toolCall);
			}
		}
		this.nativeProjection.extendText(this.innerIndex);
	}

	private flushText(): void {
		if (this.textBuffer.length === 0) return;
		this.projection.projectParserEvents([{ type: "text", text: this.textBuffer }]);
		this.textBuffer = "";
	}
}
