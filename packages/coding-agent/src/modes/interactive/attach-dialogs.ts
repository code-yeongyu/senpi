import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../rpc/rpc-types.ts";
import { AnswerRefusedError } from "./attach-client.ts";
import { AskUserQuestionComponent } from "./components/ask-user-question.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";

/** Owns only the visible dialog; the endpoint owns its resolution and lifetime. */
export class AttachDialogs extends Container {
	private readonly queue: RpcExtensionUIRequest[] = [];
	private readonly seen = new Set<string>();
	private readonly settled = new Set<string>();
	private current: { request: RpcExtensionUIRequest; component: Component & { dispose?: () => void } } | undefined;
	private closed = false;
	private readonly ui: TUI;
	private readonly keys: KeybindingsManager;
	private readonly answer: (response: RpcExtensionUIResponse) => Promise<void>;
	private readonly report: (message: string) => void;
	private readonly focusEditor: () => void;

	constructor(
		ui: TUI,
		keys: KeybindingsManager,
		answer: (response: RpcExtensionUIResponse) => Promise<void>,
		report: (message: string) => void,
		focusEditor: () => void,
	) {
		super();
		this.ui = ui;
		this.keys = keys;
		this.answer = answer;
		this.report = report;
		this.focusEditor = focusEditor;
	}

	get active(): boolean {
		return this.current !== undefined;
	}

	accept(request: RpcExtensionUIRequest): void {
		if (this.seen.has(request.id)) return;
		if (!["select", "confirm", "input", "editor", "question"].includes(request.method)) return;
		this.seen.add(request.id);
		this.queue.push(request);
		this.showNext();
	}

	/** The endpoint settled the request (another client answered it): it never comes back. */
	resolve(id: string): void {
		this.settled.add(id);
		const index = this.queue.findIndex((request) => request.id === id);
		if (index >= 0) this.queue.splice(index, 1);
		if (this.current?.request.id === id) this.dismiss();
	}

	handleInput(data: string): void {
		this.current?.component.handleInput?.(data);
	}

	dispose(): void {
		this.closed = true;
		this.queue.length = 0;
		this.current?.component.dispose?.();
		this.current = undefined;
		this.clear();
	}

	private dismiss(): void {
		this.current?.component.dispose?.();
		this.current = undefined;
		this.clear();
		this.focusEditor();
		this.showNext();
		this.ui.requestRender();
	}

	/**
	 * The dialog leaves while its answer is in flight and comes back unless the endpoint accepted it.
	 * A request the endpoint no longer waits on (settled elsewhere, or gone) stays dismissed.
	 */
	private submit(request: RpcExtensionUIRequest, response: RpcExtensionUIResponse): void {
		this.dismiss();
		this.answer(response).catch((error: unknown) => {
			const code = error instanceof AnswerRefusedError ? error.code : undefined;
			if (code === "question_already_resolved" || code === "unknown_extension_ui_request") {
				this.report(`Not accepted: ${code} (already settled)`);
				return;
			}
			if (this.closed || this.settled.has(request.id)) return;
			this.report(`${error instanceof Error ? error.message : String(error)}. Answer again.`);
			this.queue.unshift(request);
			this.showNext();
			this.ui.requestRender();
		});
	}

	private showNext(): void {
		if (this.current) return;
		const request = this.queue.shift();
		if (!request) return;
		const finish = (response: RpcExtensionUIResponse) => {
			if (this.current?.request.id !== request.id) return;
			this.submit(request, response);
		};
		const cancel = () => finish({ type: "extension_ui_response", id: request.id, cancelled: true });
		let component: Component & { dispose?: () => void };
		switch (request.method) {
			case "select":
				component = new ExtensionSelectorComponent(
					request.title,
					request.options,
					(value) => finish({ type: "extension_ui_response", id: request.id, value }),
					cancel,
					{ tui: this.ui, timeout: request.timeout },
				);
				break;
			case "confirm":
				component = new ExtensionSelectorComponent(
					request.title,
					["Yes", "No"],
					(value) => finish({ type: "extension_ui_response", id: request.id, confirmed: value === "Yes" }),
					cancel,
					{ tui: this.ui, timeout: request.timeout, description: request.message },
				);
				break;
			case "input":
				component = new ExtensionInputComponent(
					request.title,
					request.placeholder,
					(value) => finish({ type: "extension_ui_response", id: request.id, value }),
					cancel,
					{ tui: this.ui, timeout: request.timeout },
				);
				break;
			case "editor":
				component = new ExtensionEditorComponent(
					this.ui,
					this.keys,
					request.title,
					request.prefill,
					(value) => finish({ type: "extension_ui_response", id: request.id, value }),
					cancel,
				);
				break;
			case "question":
				component = new AskUserQuestionComponent(
					{
						requestId: request.requestId,
						questions: request.questions,
						waitForAnswer: request.waitForAnswer,
						timeoutMs: request.remainingMs,
					},
					(response) =>
						response.status === "answered" || response.status === "comment-submitted"
							? finish({
									type: "extension_ui_response",
									id: request.id,
									answers: response.answers,
									comment: response.comment,
								})
							: cancel(),
					{ tui: this.ui, getDeadlineAtMs: () => request.deadlineAtMs },
				);
				break;
			default:
				return;
		}
		this.current = { request, component };
		this.addChild(component);
		this.ui.setFocus(component);
		this.ui.requestRender();
	}
}
