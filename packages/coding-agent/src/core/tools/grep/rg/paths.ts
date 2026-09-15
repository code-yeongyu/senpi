import { sep } from "node:path";

export const pathOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const slashPath = (path: string): string => path.split(sep).join("/");
