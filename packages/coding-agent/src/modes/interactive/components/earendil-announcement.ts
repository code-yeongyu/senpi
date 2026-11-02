import * as fs from "node:fs";
import { Container, Image, Spacer } from "@earendil-works/pi-tui";
import { getBundledInteractiveAssetPath } from "../../../config.ts";
import { buildNoticeBox } from "../../../core/extensions/notice/index.ts";
import { theme } from "../theme/theme.ts";

const BLOG_URL = "https://mariozechner.at/posts/2026-04-08-ive-sold-out/";
const IMAGE_FILENAME = "clankolas.png";

let cachedImageBase64: string | undefined;
let attemptedImageLoad = false;

function loadImageBase64(): string | undefined {
	if (attemptedImageLoad) {
		return cachedImageBase64;
	}

	attemptedImageLoad = true;
	try {
		cachedImageBase64 = fs.readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME)).toString("base64");
	} catch {
		cachedImageBase64 = undefined;
	}
	return cachedImageBase64;
}

export class EarendilAnnouncementComponent extends Container {
	constructor() {
		super();

		this.addChild(
			buildNoticeBox(
				{
					title: "pi has joined Earendil",
					tone: "accent",
					why: "Read the blog post:",
					extra: [{ text: BLOG_URL, tone: "accent" }],
				},
				{ expanded: false },
				theme,
			),
		);
		this.addChild(new Spacer(1));

		const imageBase64 = loadImageBase64();
		if (imageBase64) {
			this.addChild(
				new Image(
					imageBase64,
					"image/png",
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 56, filename: IMAGE_FILENAME },
				),
			);
			this.addChild(new Spacer(1));
		}
	}
}
