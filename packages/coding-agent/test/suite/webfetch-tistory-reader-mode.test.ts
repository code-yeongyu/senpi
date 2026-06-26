import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Static } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { webfetch } from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void;
type WebfetchParams = Static<typeof webfetch.parameters>;

const servers: Server[] = [];
const context = {} as ExtensionContext;

async function createFixtureServer(handler: RouteHandler): Promise<{ readonly baseUrl: string }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Expected TCP server address");
	}
	servers.push(server);
	return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function executeWebfetch(params: WebfetchParams) {
	return webfetch.execute("tool", params, undefined, undefined, context);
}

function textContent(result: Awaited<ReturnType<typeof executeWebfetch>>): string {
	const first = result.content[0];
	if (first?.type !== "text") {
		throw new Error("Expected text content");
	}
	return first.text;
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function tistoryFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<head>
				<title>관리자 메뉴가 제목을 이기면 안 됨</title>
				<meta name="description" content="티스토리 블로그 홍보 문구">
			</head>
			<body class="tt-body-page">
				<header>
					<a href="/manage">관리자</a>
					<a href="/category">분류 전체보기</a>
				</header>
				<section class="sidebar">
					<h2>최근 글</h2>
					<p>관련 없는 사이드바 설명이 길게 들어가서 리더가 이 영역을 본문으로 착각하면 안 됩니다.</p>
				</section>
				<div id="content">
					<h1 class="tit_post">티스토리 본문을 읽어야 합니다</h1>
					<div class="entry-content contents_style">
						<div class="article_view tt_article_useless_p_margin">
							<p data-ke-size="size16">첫 번째 본문 문장은 짧은 티스토리 글에서도 반드시 남아야 합니다.</p>
							<p data-ke-size="size16">두 번째 본문 문장은 카테고리나 관련 글보다 우선되어야 합니다.</p>
							<figure data-ke-type="image">
								<figcaption>본문 이미지 설명도 보존됩니다.</figcaption>
							</figure>
						</div>
						<div class="another_category">
							<h4>다른 글 보기</h4>
							<ul>
								<li>관련 글 제목 하나</li>
								<li>관련 글 제목 둘</li>
							</ul>
						</div>
					</div>
				</div>
				<footer>구독하기 푸터와 방명록 링크</footer>
				<script>window.tistoryTracker = true;</script>
			</body>
		</html>`;
}

function titlePriorityFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<head>
				<title>관리자 메뉴가 제목을 이기면 안 됨</title>
				<meta name="description" content="티스토리 블로그 홍보 문구">
			</head>
			<body class="tt-body-page">
				<header>
					<h1>블로그 이름</h1>
					<a href="/manage">관리자</a>
					<a href="/category">분류 전체보기</a>
				</header>
				<section class="sidebar">
					<h2>최근 글</h2>
					<p>관련 없는 사이드바 설명이 길게 들어가서 리더가 이 영역을 본문으로 착각하면 안 됩니다.</p>
				</section>
				<div id="content">
					<h1 class="tit_post">티스토리 본문을 읽어야 합니다</h1>
					<div class="entry-content contents_style">
						<div class="article_view tt_article_useless_p_margin">
							<p data-ke-size="size16">첫 번째 본문 문장은 짧은 티스토리 글에서도 반드시 남아야 합니다.</p>
							<p data-ke-size="size16">두 번째 본문 문장은 카테고리나 관련 글보다 우선되어야 합니다.</p>
							<figure data-ke-type="image">
								<figcaption>본문 이미지 설명도 보존됩니다.</figcaption>
							</figure>
						</div>
						<div class="another_category">
							<h4>다른 글 보기</h4>
							<ul>
								<li>관련 글 제목 하나</li>
								<li>관련 글 제목 둘</li>
							</ul>
						</div>
					</div>
				</div>
				<footer>구독하기 푸터와 방명록 링크</footer>
			</body>
		</html>`;
}

function newlineFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<body>
				<div class="article_view">
					<h1>줄바꿈 보존</h1>
					<p><span>첫 줄</span><br><span>둘째 줄</span></p>
					<p><span>새 문단</span> <strong>강조</strong></p>
					<ul>
						<li><span>첫 항목</span></li>
						<li><span>둘째 항목</span></li>
					</ul>
					<table>
						<tr><td>왼쪽 칸</td><td>오른쪽 칸</td></tr>
					</table>
				</div>
			</body>
		</html>`;
}

function literalEntityFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<body>
				<article>
					<h1>Literal Entity Fixture</h1>
					<p>Rendered tag example: &amp;lt;custom-element&amp;gt;</p>
					<p>Escaped ampersand example: AT&amp;amp;T docs</p>
				</article>
			</body>
		</html>`;
}

describe("webfetch Tistory reader-mode cleanup", () => {
	it("#given Tistory article wrappers #when fetching markdown #then prefers the article body over category chrome", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(tistoryFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/tistory`, format: "markdown" });
		const text = textContent(result);

		// then
		expect(text).toContain("# 티스토리 본문을 읽어야 합니다");
		expect(text).toContain("첫 번째 본문 문장은");
		expect(text).toContain("두 번째 본문 문장은");
		expect(text).toContain("본문 이미지 설명도 보존됩니다");
		expect(text).not.toContain("관리자 메뉴가 제목을 이기면 안 됨");
		expect(text).not.toContain("분류 전체보기");
		expect(text).not.toContain("최근 글");
		expect(text).not.toContain("관련 글 제목");
		expect(text).not.toContain("구독하기 푸터");
		expect(text).not.toContain("tistoryTracker");
	});

	it("#given Tistory title chrome #when fetching markdown #then prefers the article title over site chrome", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(titlePriorityFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/tistory-title`, format: "markdown" });
		const text = textContent(result);

		// then
		expect(text).toContain("# 티스토리 본문을 읽어야 합니다");
		expect(text).toContain("첫 번째 본문 문장은");
		expect(text).toContain("두 번째 본문 문장은");
		expect(text).not.toContain("블로그 이름");
		expect(text).not.toContain("관련 없는 사이드바 설명");
	});

	it("#given Tistory title chrome #when fetching text #then prefers the article title over site chrome", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(titlePriorityFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/tistory-title-text`, format: "text" });
		const text = textContent(result);

		// then
		expect(text.startsWith("티스토리 본문을 읽어야 합니다")).toBe(true);
		expect(text).toContain("첫 번째 본문 문장은");
		expect(text).toContain("두 번째 본문 문장은");
		expect(text).not.toContain("블로그 이름");
		expect(text).not.toContain("관련 없는 사이드바 설명");
	});

	it("#given Tistory text with inline spans and blocks #when fetching text #then preserves readable line breaks", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(newlineFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/newline`, format: "text" });
		const text = textContent(result);

		// then
		expect(text).toContain("줄바꿈 보존\n\n첫 줄\n둘째 줄\n\n새 문단 강조");
		expect(text).toContain("첫 항목\n\n둘째 항목");
		expect(text).toContain("왼쪽 칸\n오른쪽 칸");
		expect(text).not.toContain("\n\n\n");
		expect(text).not.toContain("첫 줄둘째 줄");
	});

	it("#given literal HTML entity examples #when fetching markdown and text #then preserves one decoded layer only", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(literalEntityFixtureHtml());
		});

		// when
		const markdown = textContent(
			await executeWebfetch({ url: `${server.baseUrl}/literal-entity`, format: "markdown" }),
		);
		const text = textContent(await executeWebfetch({ url: `${server.baseUrl}/literal-entity`, format: "text" }));

		// then
		expect(markdown).toContain("&lt;custom-element&gt;");
		expect(markdown).toContain("AT&amp;T docs");
		expect(markdown).not.toContain("<custom-element>");
		expect(markdown).not.toContain("AT&T docs");
		expect(text).toContain("&lt;custom-element&gt;");
		expect(text).toContain("AT&amp;T docs");
		expect(text).not.toContain("<custom-element>");
		expect(text).not.toContain("AT&T docs");
	});
});
