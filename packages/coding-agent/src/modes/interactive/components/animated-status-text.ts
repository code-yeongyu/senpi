import { type Component, Text } from "@earendil-works/pi-tui";
import { AnimationFrame } from "./animation-frame.ts";

/** Animate presentation over already-computed status content, without rebuilding status rows every frame. */
export class AnimatedStatusText implements Component {
	private readonly animation: AnimationFrame;
	private readonly text = new Text("", 1, 0);
	private readonly frame: () => string;

	constructor(requestRender: () => void, frame: () => string) {
		this.frame = frame;
		this.animation = new AnimationFrame(requestRender);
	}

	render(width: number): string[] {
		this.text.setText(this.frame());
		this.animation.schedule();
		return this.text.render(width);
	}

	invalidate(): void {
		this.text.invalidate();
	}

	dispose(): void {
		this.animation.dispose();
	}
}
