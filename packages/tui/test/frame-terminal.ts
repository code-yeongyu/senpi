import { VirtualTerminal } from "./virtual-terminal.ts";

/** Subscribe to the real synchronized-output completion before triggering a frame. */
export class FrameTerminal extends VirtualTerminal {
	private onFrame?: () => void;

	override write(data: string): void {
		super.write(data);
		if (data.includes("\x1b[?2026l")) this.onFrame?.();
	}

	async frame(action: () => void): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const deadline = setTimeout(() => {
				this.onFrame = undefined;
				reject(new Error("No completed TUI frame"));
			}, 2000);
			this.onFrame = () => {
				clearTimeout(deadline);
				this.onFrame = undefined;
				void this.flush().then(resolve, reject);
			};
			action();
		});
	}
}
