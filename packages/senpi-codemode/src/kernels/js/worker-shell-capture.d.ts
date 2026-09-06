export type ShellCaptureStream = "stdout" | "stderr";

export type ShellCaptureRestore = () => void;

export interface ShellCaptureOptions {
	readonly isActive: () => boolean;
	readonly emitText: (stream: ShellCaptureStream, data: string) => void;
}

export function installShellCapture(options: ShellCaptureOptions): ShellCaptureRestore;
