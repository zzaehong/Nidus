import XCTest
@testable import Nidus

final class MarkdownHTMLTests: XCTestCase {
    private func render(_ text: String, _ context: MarkdownHTML.Context = .init()) -> String { MarkdownHTML.render(text, context) }

    func testHeadingsParagraphsAndInlineStyles() {
        let html = render("# 제목\n\n첫 줄 **굵게** *기울임* ~~취소~~ ==강조== `code **x**`\n둘째 줄\n\n## 둘")
        XCTAssertTrue(html.contains("<h1>제목</h1>"))
        XCTAssertTrue(html.contains("<p>첫 줄 <strong>굵게</strong> <em>기울임</em> <del>취소</del> <mark>강조</mark> <code>code **x**</code><br>\n둘째 줄</p>"), html)
        XCTAssertTrue(html.contains("<h2>둘</h2>"))
    }

    func testRawHTMLIsShownNotRun() {
        let html = render("<script>alert(1)</script> & [x](javascript:alert(1)) <img src=x onerror=y>")
        XCTAssertFalse(html.contains("<script>"))
        XCTAssertTrue(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp;"))
        XCTAssertTrue(html.contains("<a href=\"#\">x</a>"))
        XCTAssertFalse(html.contains("<img"))
    }

    func testListsNestAndTasksShowTheirState() {
        let html = render("- 하나\n  - 안쪽\n  - 안쪽 둘\n- [ ] 할 일\n- [x] 한 일\n\n3. 셋\n4. 넷")
        XCTAssertTrue(html.contains("<li>하나\n<ul>\n<li>안쪽</li>\n<li>안쪽 둘</li>\n</ul></li>"), html)
        XCTAssertTrue(html.contains("<li class=\"task\"><input type=\"checkbox\" disabled> 할 일</li>"))
        XCTAssertTrue(html.contains("<li class=\"task\"><input type=\"checkbox\" disabled checked> 한 일</li>"))
        XCTAssertTrue(html.contains("<ol start=\"3\">\n<li>셋</li>\n<li>넷</li>\n</ol>"), html)
    }

    func testTablesCodeQuotesAndRules() {
        let html = render("| 이름 | 값 |\n|:--|--:|\n| a | 1 |\n| b \\| c |\n\n```swift\nlet x = \"<1>\"\n```\n\n> 인용\n> 둘째\n\n---\n\n> [!warning] 주의\n> 내용")
        XCTAssertTrue(html.contains("<th>이름</th><th style=\"text-align:right\">값</th>"), html)
        XCTAssertTrue(html.contains("<tr><td>a</td><td style=\"text-align:right\">1</td></tr>"))
        XCTAssertTrue(html.contains("<tr><td>b | c</td><td style=\"text-align:right\"></td></tr>"))
        XCTAssertTrue(html.contains("<pre><code class=\"language-swift\">let x = &quot;&lt;1&gt;&quot;</code></pre>"))
        XCTAssertTrue(html.contains("<blockquote><p>인용<br>\n둘째</p></blockquote>"))
        XCTAssertTrue(html.contains("<hr>"))
        XCTAssertTrue(html.contains("<div class=\"callout callout-warning\"><div class=\"callout-title\">주의</div><p>내용</p></div>"), html)
    }

    func testFrontMatterBecomesProperties() {
        let html = render("---\ntype: lesson\ndate: 2026-11-13\n---\n# 교훈\n")
        XCTAssertTrue(html.hasPrefix("<table class=\"props\"><tr><th>type</th><td>lesson</td></tr><tr><th>date</th><td>2026-11-13</td></tr></table>"), html)
        XCTAssertTrue(html.contains("<h1>교훈</h1>"))
        XCTAssertFalse(html.contains("<hr>"))
    }

    func testWikiLinksEmbedsImagesAndTags() {
        var context = MarkdownHTML.Context()
        context.noteExists = { $0 == "있는 노트" }
        context.image = { $0 == "그림.png" || $0 == "a b.png" ? "data:image/png;base64,AAAA" : nil }
        let html = render("[[있는 노트]] [[없는 노트|별칭]] [[있는 노트#절]] ![[그림.png|200]] ![설명](a%20b.png) ![x](없음.png) #태그 #프로젝트/하위 #123 https://example.com/a?b=1&c=2.", context)
        XCTAssertTrue(html.contains("<a class=\"wiki\" href=\"nidus-wiki:%EC%9E%88%EB%8A%94%20%EB%85%B8%ED%8A%B8\">있는 노트</a>"), html)
        XCTAssertTrue(html.contains("<a class=\"wiki missing\" href=\"nidus-wiki:%EC%97%86%EB%8A%94%20%EB%85%B8%ED%8A%B8\">별칭</a>"))
        XCTAssertTrue(html.contains("%23%EC%A0%88\">있는 노트#절</a>"), html)
        XCTAssertTrue(html.contains("<img src=\"data:image/png;base64,AAAA\" alt=\"그림.png\" width=\"200\">"))
        XCTAssertTrue(html.contains("<img src=\"data:image/png;base64,AAAA\" alt=\"설명\">"))
        XCTAssertTrue(html.contains("[이미지 없음: 없음.png]"))
        XCTAssertTrue(html.contains("<span class=\"tag\">#태그</span> <span class=\"tag\">#프로젝트/하위</span> #123"))
        XCTAssertTrue(html.contains("<a href=\"https://example.com/a?b=1&amp;c=2\">https://example.com/a?b=1&amp;c=2</a>."), html)
    }

    func testThePageForbidsScriptsAndRemoteLoads() {
        let page = MarkdownHTML.page(body: "<p>x</p>", title: "a<b")
        XCTAssertTrue(page.contains("default-src 'none'"))
        XCTAssertTrue(page.contains("<title>a&lt;b</title>"))
    }
}
