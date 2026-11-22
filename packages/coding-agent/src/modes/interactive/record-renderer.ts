import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { AttachRecord } from "./attach-client.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { sharedMarkdownTheme, theme } from "./theme/theme.ts";

type Row = { key: string; component: Component; message: AgentMessage };

/** Adapts canonical history and streaming RPC records to the existing TUI message components. */
export class RecordRenderer extends Container {
	private rows: Row[] = [];
	private readonly finalized = new Set<string>();
	private readonly historyKeys = new Map<string, string>();
	private active: { key: string; message: AssistantMessage; component: AssistantMessageComponent } | undefined;

	prepend(entries: readonly SessionEntry[]): void {
		const added: Row[] = [];
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const key = entry.id;
			this.historyKeys.set(this.messageKey(entry.message), key);
			this.finalized.add(key);
			if (this.rows.some((row) => row.key === key)) continue;
			added.push({ key, message: entry.message, component: this.component(entry.message) });
		}
		this.rows = [...added, ...this.rows];
		this.rebuild();
	}

	accept(record: AttachRecord): void {
		switch (record.type) {
			case "message_start":
				if (this.finalized.has(this.key(record.message, record.entryId))) return;
				this.put(record.message, record.entryId);
				break;
			case "message_update": {
				// Socket hosts may coalesce deltas into an authoritative cumulative message.
				if (record.message) {
					this.put(record.message, record.entryId);
					break;
				}
				const active = this.active;
				if (!active) return;
				const event = record.assistantMessageEvent;
				const content = active.message.content;
				switch (event.type) {
					case "text_start":
						content[event.contentIndex] = { type: "text", text: "" };
						break;
					case "thinking_start":
						content[event.contentIndex] = { type: "thinking", thinking: "" };
						break;
					case "text_delta": {
						const part = content[event.contentIndex];
						if (part?.type === "text") part.text += event.delta;
						else content[event.contentIndex] = { type: "text", text: event.delta };
						break;
					}
					case "thinking_delta": {
						const part = content[event.contentIndex];
						if (part?.type === "thinking") part.thinking += event.delta;
						else content[event.contentIndex] = { type: "thinking", thinking: event.delta };
						break;
					}
					case "toolcall_start":
						content[event.contentIndex] = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
						break;
					case "toolcall_end":
						content[event.contentIndex] = event.toolCall;
						break;
					default:
						break;
				}
				active.message.usage = record.usage;
				active.component.updateContent(active.message);
				break;
			}
			case "message_end":
				this.put(record.message, record.entryId);
				this.finalized.add(this.key(record.message, record.entryId));
				this.active = undefined;
				break;
			default:
				break;
		}
	}

	private messageKey(message: AgentMessage): string {
		return message.role === "toolResult" ? `tool:${message.toolCallId}` : `${message.role}:${message.timestamp}`;
	}

	private key(message: AgentMessage, entryId?: string): string {
		return entryId ?? this.historyKeys.get(this.messageKey(message)) ?? this.messageKey(message);
	}

	private put(message: AgentMessage, entryId?: string): void {
		const key = this.key(message, entryId);
		const existing =
			this.rows.find((row) => row.key === key) ??
			this.rows.find(
				(row) => !this.finalized.has(row.key) && this.messageKey(row.message) === this.messageKey(message),
			);
		if (message.role === "assistant") {
			const component =
				existing?.component instanceof AssistantMessageComponent
					? existing.component
					: new AssistantMessageComponent();
			const snapshot = structuredClone(message);
			component.updateContent(snapshot);
			this.active = { key, message: snapshot, component };
			if (existing) {
				existing.key = key;
				existing.component = component;
				existing.message = snapshot;
			} else this.rows.push({ key, message: snapshot, component });
		} else if (existing) {
			existing.key = key;
			existing.message = message;
			existing.component = this.component(message);
		} else {
			this.rows.push({ key, message, component: this.component(message) });
		}
		this.rebuild();
	}

	private component(message: AgentMessage): Component {
		switch (message.role) {
			case "assistant":
				return new AssistantMessageComponent(message);
			case "user": {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
				return new UserMessageComponent(text);
			}
			case "toolResult": {
				const text = message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
				const result = new Container();
				result.addChild(new Text(theme.fg("muted", message.toolName), 1, 0));
				result.addChild(new Markdown(text, 1, 0, sharedMarkdownTheme()));
				return result;
			}
			default:
				return new Text("content" in message ? String(message.content) : message.role, 1, 0);
		}
	}

	private rebuild(): void {
		this.clear();
		for (const row of this.rows) this.addChild(row.component);
	}
}
