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

function handleOwnAnswerKey(ctx: AskUserKeyHandlerContext, data: string, kb: ReturnType<typeof getKeybindings>): void {
	if (matchesKey(data, "ctrl+enter")) {
		ctx.commitOwnAnswer();
		ctx.attemptSubmit();
		return;
	}
	if (kb.matches(data, "tui.select.confirm") || data === "\n") {
		ctx.commitOwnAnswer();
		ctx.state.advance();
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		if (ctx.state.request.waitForAnswer) ctx.state.returnToOptions();
		else ctx.finish("cancelled");
		ctx.updateAll();
		return;
	}
	ctx.ownAnswerInput.handleInput(data);
	ctx.emitProgress();
}

function handleSubmitKey(ctx: AskUserKeyHandlerContext, data: string, kb: ReturnType<typeof getKeybindings>): void {
	if (matchesKey(data, "ctrl+enter") || kb.matches(data, "tui.input.submit") || data === "\n") {
		ctx.attemptSubmit();
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		if (ctx.state.request.waitForAnswer) ctx.state.returnToOptions();
		else ctx.finish("cancelled");
		ctx.updateAll();
		return;
	}
	if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
		ctx.state.switchTab(-1);
		ctx.updateAll();
		return;
	}
	if (matchesKey(data, "tab") || matchesKey(data, "right")) {
		ctx.state.switchTab(1);
		ctx.updateAll();
		return;
	}
	ctx.commentInput.handleInput(data);
	ctx.state.comment = ctx.commentInput.getValue();
	ctx.emitProgress();
}

function handleOptionsKey(ctx: AskUserKeyHandlerContext, data: string, kb: ReturnType<typeof getKeybindings>): void {
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
	if (data.length === 1 && data >= "1" && data <= "9") {
		const option = state.activeQuestion.options[Number(data) - 1];
		if (option) {
			state.activateOption(state.activeQuestion.id, option.label);
			ctx.emitProgress();
			if (!state.activeQuestion.multiSelect) {
				if (state.request.waitForAnswer && state.request.questions.length === 1) ctx.attemptSubmit();
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
		state.focus = "submit";
		ctx.updateAll();
		return;
	}
	if (data.length === 1 && data >= " " && data !== "c") {
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
	if (!confirm || !state.activeQuestion.multiSelect) {
		state.activateOption(state.activeQuestion.id, option.label);
	}
	ctx.emitProgress();
	ctx.updateAll();
	if (confirm) {
		if (!state.activeQuestion.multiSelect && state.request.waitForAnswer && state.request.questions.length === 1) {
			ctx.attemptSubmit();
		} else {
			state.advance();
			ctx.updateAll();
		}
	}
}
