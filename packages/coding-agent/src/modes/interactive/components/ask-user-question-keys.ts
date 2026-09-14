/**
 * Key dispatch for the ask-user question overlay. Split from the component to
 * keep every sibling under 250 LOC; handlers operate on the shared state and
 * the component's Inputs via an explicit context.
 */

import { getKeybindings, type Input, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionResponse } from "../../../core/extensions/types.ts";
import type { AskUserQuestionState } from "./ask-user-question-state.ts";

export interface AskUserKeyHandlerContext {
	state: AskUserQuestionState;
	ownAnswerInput: Input;
	commentInput: Input;
	finish(status: QuestionResponse["status"], autoResolvedAfterMs?: number): void;
	attemptSubmit(): void;
	openOwnAnswer(initialText?: string): void;
	commitOwnAnswer(): void;
	emitProgress(): void;
	updateAll(): void;
}

type Keybindings = ReturnType<typeof getKeybindings>;

const DEL = "\x7f";

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== DEL;
}

export function handleAskUserKeyInput(ctx: AskUserKeyHandlerContext, data: string): void {
	const kb = getKeybindings();
	if (matchesKey(data, "ctrl+c")) {
		ctx.finish("cancelled");
		return;
	}
	if (ctx.state.focus === "own-answer") {
		handleOwnAnswerKey(ctx, data, kb);
		return;
	}
	if (ctx.state.focus === "submit") {
		handleSubmitKey(ctx, data, kb);
		return;
	}
	handleOptionsKey(ctx, data, kb);
}

/** Navigation out of the editor saves typed text but never wipes an existing answer with an empty editor. */
function saveTypedOwnAnswer(ctx: AskUserKeyHandlerContext): void {
	if (ctx.ownAnswerInput.getValue().trim() !== "") ctx.commitOwnAnswer();
	else ctx.ownAnswerInput.setValue("");
}

function handleOwnAnswerKey(ctx: AskUserKeyHandlerContext, data: string, kb: Keybindings): void {
	const state = ctx.state;
	if (matchesKey(data, "ctrl+enter")) {
		ctx.commitOwnAnswer();
		ctx.attemptSubmit();
		return;
	}
	if (kb.matches(data, "tui.select.confirm") || data === "\n") {
		ctx.commitOwnAnswer();
		state.advance();
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		ctx.ownAnswerInput.setValue("");
		state.leaveOwnAnswer(state.ownAnswerRowIndex);
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.up")) {
		saveTypedOwnAnswer(ctx);
		state.leaveOwnAnswer(state.ownAnswerRowIndex - 1);
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.down")) {
		saveTypedOwnAnswer(ctx);
		state.leaveOwnAnswer(state.ownAnswerRowIndex);
		ctx.updateAll();
		return;
	}
	if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
		saveTypedOwnAnswer(ctx);
		state.switchTab(matchesKey(data, "tab") ? 1 : -1);
		ctx.updateAll();
		return;
	}
	if (matchesKey(data, "backspace") && ctx.ownAnswerInput.getValue() === "") {
		state.leaveOwnAnswer(state.ownAnswerRowIndex);
		ctx.updateAll();
		return;
	}
	ctx.ownAnswerInput.handleInput(data);
	ctx.emitProgress();
}

function handleSubmitKey(ctx: AskUserKeyHandlerContext, data: string, kb: Keybindings): void {
	const state = ctx.state;
	if (matchesKey(data, "ctrl+enter")) {
		ctx.attemptSubmit();
		return;
	}
	if (kb.matches(data, "tui.input.submit") || data === "\n") {
		if (state.isCommentFocused) ctx.attemptSubmit();
		else {
			state.jumpToQuestion(state.submitRowIndex);
			ctx.updateAll();
		}
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		if (state.request.waitForAnswer) state.returnToOptions();
		else ctx.finish("cancelled");
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
		state.moveSubmitRow(kb.matches(data, "tui.select.up") ? -1 : 1);
		ctx.updateAll();
		return;
	}
	if (matchesKey(data, "shift+tab") || matchesKey(data, "tab")) {
		state.switchTab(matchesKey(data, "tab") ? 1 : -1);
		ctx.updateAll();
		return;
	}
	const commentHasText = ctx.commentInput.getValue() !== "";
	if (matchesKey(data, "left") || matchesKey(data, "right")) {
		if (!state.isCommentFocused || !commentHasText) {
			state.switchTab(matchesKey(data, "right") ? 1 : -1);
			ctx.updateAll();
			return;
		}
	}
	if (matchesKey(data, "backspace") && state.isCommentFocused && !commentHasText) {
		state.moveSubmitRow(-1);
		ctx.updateAll();
		return;
	}
	if (!state.isCommentFocused) {
		if (!isPrintable(data)) return;
		state.focusComment();
	}
	ctx.commentInput.handleInput(data);
	state.comment = ctx.commentInput.getValue();
	ctx.updateAll();
	ctx.emitProgress();
}

function handleOptionsKey(ctx: AskUserKeyHandlerContext, data: string, kb: Keybindings): void {
	const state = ctx.state;
	if (matchesKey(data, "ctrl+enter")) {
		ctx.attemptSubmit();
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		if (!state.request.waitForAnswer || state.requestDismiss() === "cancel") ctx.finish("cancelled");
		else ctx.updateAll();
		return;
	}
	if (matchesKey(data, "tab") || matchesKey(data, "right")) {
		state.switchTab(1);
		ctx.updateAll();
		return;
	}
	if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
		state.switchTab(-1);
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.up") || data === "k") {
		state.highlightIndex = Math.max(0, state.highlightIndex - 1);
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.down") || data === "j") {
		state.highlightIndex = Math.min(state.ownAnswerRowIndex, state.highlightIndex + 1);
		ctx.updateAll();
		return;
	}
	if (matchesKey(data, "backspace")) {
		state.clearAnswer(state.activeQuestion.id);
		ctx.emitProgress();
		ctx.updateAll();
		return;
	}
	if (data.length === 1 && data >= "1" && data <= "9") {
		const option = state.activeQuestion.options[Number(data) - 1];
		if (option) {
			state.activateOption(state.activeQuestion.id, option.label);
			ctx.emitProgress();
			if (!state.activeQuestion.multiSelect) {
				if (state.request.questions.length === 1) ctx.attemptSubmit();
				else state.advance();
			}
			ctx.updateAll();
		}
		return;
	}
	if (matchesKey(data, "space")) {
		activateHighlighted(ctx, false);
		return;
	}
	if (kb.matches(data, "tui.select.confirm") || data === "\n") {
		activateHighlighted(ctx, true);
		return;
	}
	if (data === "c") {
		state.enterSubmit();
		ctx.updateAll();
		return;
	}
	if (isPrintable(data)) {
		ctx.openOwnAnswer(data);
		ctx.updateAll();
	}
}

function activateHighlighted(ctx: AskUserKeyHandlerContext, confirm: boolean): void {
	const state = ctx.state;
	if (state.highlightIndex === state.ownAnswerRowIndex) {
		ctx.openOwnAnswer();
		return;
	}
	const option = state.activeQuestion.options[state.highlightIndex];
	if (!option) return;
	state.activateOption(state.activeQuestion.id, option.label);
	ctx.emitProgress();
	ctx.updateAll();
	if (confirm) {
		if (!state.activeQuestion.multiSelect && state.request.questions.length === 1) {
			ctx.attemptSubmit();
		} else if (!state.activeQuestion.multiSelect) {
			state.advance();
			ctx.updateAll();
		}
		/* multi-select + Enter: toggle only, do not advance — user presses Tab/Submit when done */
	}
}
