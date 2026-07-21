import type { Tool } from "../../../types.ts";
import { findFunctionCallsCloseTag } from "./invoke-stream-helpers.ts";
import { findInvokeOpenTag } from "./invoke-tag-scanner.ts";
import { ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH } from "./stream-boundary.ts";

type RecoveryWrapperOverflowAction = {
	readonly type: "overflow";
	readonly text: string;
	readonly retainedLength: number;
	readonly retainsWrapper: boolean;
	readonly nextCharacter?: string;
};

export type RecoveryWrapperAction =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "known"; readonly textBefore: string; readonly opening: string; readonly tool: Tool }
	| { readonly type: "closed"; readonly text: string }
	| RecoveryWrapperOverflowAction;

/** Owns a function_calls wrapper until its matching close, preserving interior literal text. */
export class RecoveryWrapperState {
	private beforeKnown = "";
	private tag = "";
	private recovered = false;
	private readonly opening: string;
	private readonly resolveTool: (name: string) => Tool | undefined;

	constructor(opening: string, resolveTool: (name: string) => Tool | undefined) {
		this.opening = opening;
		this.resolveTool = resolveTool;
	}

	feed(character: string): RecoveryWrapperAction[] {
		if (this.tag.length === 0) {
			if (character === "<") {
				this.tag = "<";
				return [];
			}
			return this.literal(character);
		}
		if (character === "<") {
			const tag = this.tag;
			this.tag = "<";
			return this.literal(tag);
		}
		const overflow = this.preAppendOverflow(character);
		if (overflow) {
			return [overflow];
		}
		this.tag += character;
		if (character !== ">") {
			return this.checkOverflow();
		}

		const tag = this.tag;
		this.tag = "";
		const invoke = findInvokeOpenTag(tag, 0);
		if (invoke?.index === 0 && invoke.length === tag.length) {
			const tool = this.resolveTool(invoke.toolName);
			if (tool) {
				const textBefore = this.beforeKnown;
				this.beforeKnown = "";
				this.recovered = true;
				return [{ type: "known", textBefore, opening: tag, tool }];
			}
		}
		const close = findFunctionCallsCloseTag(tag, 0);
		if (close?.index === 0 && close.length === tag.length) {
			return [{ type: "closed", text: this.recovered ? "" : this.opening + this.beforeKnown + tag }];
		}
		return this.literal(tag);
	}

	finish(): string {
		return this.recovered ? this.tag : this.opening + this.beforeKnown + this.tag;
	}

	private literal(text: string): RecoveryWrapperAction[] {
		if (this.recovered) {
			return text.length > 0 ? [{ type: "text", text }] : [];
		}
		this.beforeKnown += text;
		return this.checkOverflow();
	}

	private checkOverflow(): RecoveryWrapperAction[] {
		const retainedLength = this.retainedLength();
		if (retainedLength !== ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH) {
			return [];
		}
		return [this.flushOverflow(retainedLength)];
	}

	private preAppendOverflow(character: string): RecoveryWrapperOverflowAction | undefined {
		const retainedLength = this.retainedLength();
		return retainedLength + character.length > ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH
			? { ...this.flushOverflow(retainedLength), nextCharacter: character }
			: undefined;
	}

	private retainedLength(): number {
		return this.recovered ? this.tag.length : this.opening.length + this.beforeKnown.length + this.tag.length;
	}

	private flushOverflow(retainedLength: number): RecoveryWrapperOverflowAction {
		const text = this.recovered ? this.tag : this.opening + this.beforeKnown + this.tag;
		this.tag = "";
		return { type: "overflow", text, retainedLength, retainsWrapper: this.recovered };
	}
}
