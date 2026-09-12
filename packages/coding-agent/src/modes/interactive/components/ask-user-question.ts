/**
 * Ask-user question overlay: tab bar of question headers, numbered options
 * with descriptions, per-question own-answer editor, one always-visible
 * comment editor, submit footer and a countdown chip. Layout lives in
 * ask-user-question-render.ts, interaction rules in ask-user-question-state.ts
 * and key dispatch in ask-user-question-keys.ts.
 */

import { Container, type Focusable, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { QuestionRequest, QuestionResponse } from "../../../core/extensions/types.ts";
import { type AskUserKeyHandlerContext, handleAskUserKeyInput } from "./ask-user-question-keys.ts";
import {
	renderCommentLabel,
	renderHintsLine,
	renderNotice,
	renderOwnAnswerLabel,
	renderQuestionLine,
	renderQuestionList,
	renderSubmitLine,
	renderSubmitSummary,
	renderTabBar,
	renderTitle,
} from "./ask-user-question-render.ts";
import {
	AskUserQuestionState,
	formatCountdownLabel,
	NOT_ANSWERED_NOTICE,
	type QuestionDraft,
} from "./ask-user-question-state.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface AskUserQuestionOptions {
	tui?: TUI;
	/** Idle countdown duration; defaults to the request's timeoutMs. */
	timeoutMs?: number;
	/** Draft notification on every selection or keystroke (drives the idle timer). */
	onProgress?: (draft: QuestionDraft) => void;
}

export class AskUserQuestionComponent extends Container implements Focusable {
	private readonly state: AskUserQuestionState;
	private readonly doneCallback: (response: QuestionResponse) => void;
	private readonly options: AskUserQuestionOptions;
	private readonly ownAnswerInput = new Input();
	private readonly commentInput = new Input();
	private readonly countdown: CountdownTimer | undefined;
	private readonly titleText: Text;
	private readonly tabText: Text;
	private readonly questionText: Text;
	private readonly listContainer = new Container();
	private readonly ownAnswerContainer = new Container();
	private readonly submitContainer = new Container();
	private readonly noticeText: Text;
	private readonly submitText: Text;
	private readonly hintsText: Text;
	private readonly keyHandlerContext: AskUserKeyHandlerContext;
	private countdownLabel = "";
	private settled = false;
	private _focused = false;

	constructor(
		request: QuestionRequest,
		done: (response: QuestionResponse) => void,
		opts: AskUserQuestionOptions = {},
	) {
		super();
		this.state = new AskUserQuestionState(request);
		this.doneCallback = done;
		this.options = opts;
		this.keyHandlerContext = {
			state: this.state,
			ownAnswerInput: this.ownAnswerInput,
			commentInput: this.commentInput,
			finish: (status, autoResolvedAfterMs) => this.finish(status, autoResolvedAfterMs),
			attemptSubmit: () => this.attemptSubmit(),
			openOwnAnswer: (initialText) => this.openOwnAnswer(initialText),
			commitOwnAnswer: () => this.commitOwnAnswer(),
			emitProgress: () => this.emitProgress(),
			updateAll: () => this.updateAll(),
		};

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.tabText = new Text("", 1, 0);
		this.addChild(this.tabText);
		this.questionText = new Text("", 1, 0);
		this.addChild(this.questionText);
		this.addChild(this.listContainer);
		this.addChild(this.ownAnswerContainer);
		this.addChild(this.submitContainer);
		this.noticeText = new Text("", 1, 0);
		this.addChild(this.noticeText);
		this.submitText = new Text("", 1, 0);
		this.addChild(this.submitText);
		this.hintsText = new Text("", 1, 0);
		this.addChild(this.hintsText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		const timeoutMs = opts.timeoutMs ?? request.timeoutMs;
		if (timeoutMs > 0) {
			this.countdown = new CountdownTimer(
				timeoutMs,
				opts.tui,
				(seconds) => {
					this.countdownLabel = formatCountdownLabel(seconds * 1000);
					this.updateTitle();
					this.options.tui?.requestRender();
				},
				() => this.finish("timed_out", timeoutMs),
			);
		}
		this.updateAll();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.applyFocusFlags();
	}

	handleInput(data: string): void {
		handleAskUserKeyInput(this.keyHandlerContext, data);
	}

	dispose(): void {
		this.countdown?.dispose();
	}

	private openOwnAnswer(initialText?: string): void {
		this.state.focus = "own-answer";
		const existing = this.state.textFor(this.state.activeQuestion.id) ?? "";
		this.ownAnswerInput.setValue("");
		if (existing !== "") this.ownAnswerInput.handleInput(existing);
		if (initialText !== undefined) this.ownAnswerInput.handleInput(initialText);
		this.updateAll();
	}

	private commitOwnAnswer(): void {
		this.state.setOwnAnswer(this.state.activeQuestion.id, this.ownAnswerInput.getValue());
		this.emitProgress();
	}

	private attemptSubmit(): void {
		this.state.comment = this.commentInput.getValue();
		const outcome = this.state.submitOutcome(this.state.notice !== undefined);
		if (!outcome) {
			this.state.notice = NOT_ANSWERED_NOTICE;
			this.updateAll();
			return;
		}
		this.state.acceptPartialSubmit();
		this.finish(outcome);
	}

	private emitProgress(): void {
		const draft = this.state.refreshDraft();
		if (this.state.focus === "own-answer") {
			const live = this.ownAnswerInput.getValue().trim();
			if (live !== "") {
				draft.answers = {
					...draft.answers,
					[this.state.activeQuestion.id]: { selected: [], text: live },
				};
			}
		}
		this.options.onProgress?.(draft);
	}

	private finish(status: QuestionResponse["status"], autoResolvedAfterMs?: number): void {
		if (this.settled) return;
		this.settled = true;
		this.countdown?.dispose();
		this.state.comment = this.commentInput.getValue();
		this.doneCallback(this.state.buildResponse(status, autoResolvedAfterMs));
	}

	private applyFocusFlags(): void {
		this.ownAnswerInput.focused = this._focused && this.state.focus === "own-answer";
		this.commentInput.focused = this._focused && this.state.focus === "submit";
	}

	private updateTitle(): void {
		this.titleText.setText(renderTitle(this.countdownLabel));
	}

	private updateAll(): void {
		this.updateTitle();
		this.applyFocusFlags();
		this.tabText.setText(renderTabBar(this.state));
		this.questionText.setText(
			this.state.focus === "submit" ? "Review your answers" : renderQuestionLine(this.state.activeQuestion),
		);

		this.listContainer.clear();
		for (const line of this.state.focus === "submit"
			? renderSubmitSummary(this.state)
			: renderQuestionList(this.state)) {
			this.listContainer.addChild(new Text(line, 1, 0));
		}

		this.ownAnswerContainer.clear();
		if (this.state.focus === "own-answer") {
			this.ownAnswerContainer.addChild(new Text(renderOwnAnswerLabel(), 1, 0));
			this.ownAnswerContainer.addChild(this.ownAnswerInput);
		}

		this.submitContainer.clear();
		if (this.state.focus === "submit") {
			this.submitContainer.addChild(new Spacer(1));
			this.submitContainer.addChild(new Text(renderCommentLabel(), 1, 0));
			this.submitContainer.addChild(this.commentInput);
		}
		this.noticeText.setText(renderNotice(this.state.notice));
		this.submitText.setText(renderSubmitLine(this.state));
		this.hintsText.setText(renderHintsLine(this.state));
	}
}
