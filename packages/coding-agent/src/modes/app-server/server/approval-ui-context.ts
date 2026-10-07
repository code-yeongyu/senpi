import type { ExtensionUIContext } from "../../../core/extensions/index.ts";
import { getAvailableThemesWithPaths, getThemeByName, type Theme, theme } from "../../interactive/theme/theme.ts";
import type { ApprovalBridge } from "./approval-bridge.ts";
import { type ApprovalKind, CANCEL_REASON, NO_SUBSCRIBER_REASON, PERMISSION_OPTIONS } from "./approval-types.ts";
import type { UserInputBridge } from "./user-input-bridge.ts";

type PermissionPrompt = Readonly<{ kind: ApprovalKind; toolName: string; command: string | null; reason: string }>;

export function createAppServerUIContext(
	bridge: ApprovalBridge,
	threadId: string,
	userInput?: UserInputBridge,
	getTurnId: () => string = () => "turn-user-input",
): ExtensionUIContext {
	let pendingInput: string | undefined;
	let editorText = "";
	let editorFactory: Parameters<ExtensionUIContext["setEditorComponent"]>[0] | undefined;
	let toolsExpanded = false;

	return {
		question(request, opts) {
			return (
				userInput?.requestUserInput(threadId, getTurnId(), request.requestId, request, opts) ??
				Promise.resolve({
					status: "unavailable",
					answers: {},
					unanswered: request.questions.map((question) => question.id),
				})
			);
		},
		async select(title, options) {
			const prompt = parsePermissionPrompt(title);
			if (!prompt || !isPermissionOptions(options)) {
				return undefined;
			}
			const outcome = await bridge.requestApproval(threadId, prompt.kind, {
				turnId: "turn-approval",
				itemId: `approval-${prompt.toolName}`,
				toolName: prompt.toolName,
				command: prompt.command,
				reason: prompt.reason,
			});
			if (outcome.decision === "accept") return "Allow once";
			if (outcome.decision === "acceptForSession") return "Allow always";
			if (outcome.reason && outcome.reason !== NO_SUBSCRIBER_REASON && outcome.reason !== CANCEL_REASON) {
				pendingInput = outcome.reason;
				return "Deny with feedback";
			}
			return "Deny";
		},
		async confirm(title, message) {
			const outcome = await bridge.requestApproval(threadId, "commandExecution", {
				turnId: "turn-approval",
				itemId: "approval-confirm",
				toolName: "confirm",
				command: title,
				reason: message,
			});
			return outcome.allow;
		},
		async input() {
			const value = pendingInput;
			pendingInput = undefined;
			return value;
		},
		notify(): void {},
		onTerminalInput(): () => void {
			return () => {};
		},
		setStatus(): void {},
		setWorkingMessage(): void {},
		setWorkingVisible(): void {},
		setWorkingIndicator(): void {},
		setHiddenThinkingLabel(): void {},
		setWidget(): void {},
		setFooter(): void {},
		setHeader(): void {},
		setTitle(): void {},
		custom<T>(): Promise<T> {
			return Promise.reject(new Error("Custom UI is not available in app-server mode."));
		},
		pasteToEditor(text): void {
			editorText = text;
		},
		setEditorText(text): void {
			editorText = text;
		},
		getEditorText(): string {
			return editorText;
		},
		async editor(_title, prefill) {
			return prefill;
		},
		addAutocompleteProvider(): void {},
		setEditorComponent(factory): void {
			editorFactory = factory;
		},
		getEditorComponent() {
			return editorFactory;
		},
		theme,
		getAllThemes: getAvailableThemesWithPaths,
		getTheme(name): Theme | undefined {
			return getThemeByName(name);
		},
		setTheme(_nextTheme: string | Theme): { success: boolean; error?: string } {
			return { success: false, error: "Theme switching is not available in app-server mode." };
		},
		getToolsExpanded(): boolean {
			return toolsExpanded;
		},
		setToolsExpanded(expanded): void {
			toolsExpanded = expanded;
		},
	};
}

function parsePermissionPrompt(title: string): PermissionPrompt | undefined {
	const [firstLine = "", ...rest] = title.split("\n");
	const prefix = "Permission required: ";
	if (!firstLine.startsWith(prefix)) return undefined;
	const toolName = firstLine.slice(prefix.length).trim();
	const reason = rest.join("\n").trim();
	return {
		kind: permissionKind(toolName),
		toolName,
		command:
			readLineValue(reason, "Command: $ ") ??
			readLineValue(reason, "File: ") ??
			readLineValue(reason, "Path: ") ??
			null,
		reason,
	};
}

function permissionKind(toolName: string): ApprovalKind {
	return toolName === "edit" || toolName === "write" || toolName === "apply_patch" || toolName === "multiedit"
		? "fileChange"
		: "commandExecution";
}

function readLineValue(text: string, prefix: string): string | undefined {
	return text
		.split("\n")
		.find((line) => line.startsWith(prefix))
		?.slice(prefix.length);
}

function isPermissionOptions(options: readonly string[]): boolean {
	return PERMISSION_OPTIONS.every((option) => options.includes(option));
}
