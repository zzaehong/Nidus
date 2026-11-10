import XCTest
@testable import Nidus

final class ModelsTests: XCTestCase {
    func testOverviewDecodesTheEngineShape() throws {
        let json = """
        {"vault":"/tmp/v","budgetUSD":"12.500000000","budgetWarning":null,
         "slots":[{"id":"worker.simple","role":"worker","difficulty":"simple","candidates":["groq:a","deepseek:b"],"resolved":"deepseek:b","reason":"worker.simple: fallback #1","problem":null},
                  {"id":"roles.main","role":"main","difficulty":null,"candidates":[],"resolved":null,"reason":null,"problem":"No usable model"}],
         "providers":[{"id":"gemini","name":"Gemini","keyURL":"https://example.com","needsAccountId":false,"connected":true,"models":62,"fetchedAt":"2026-11-11T00:00:00Z"}],
         "usage":{"month":"2026-11","calls":3,"costUSD":"0.000018000","unknownCostCalls":1,
           "groups":[{"role":"worker","difficulty":"normal","provider":"deepseek","model":"b","calls":2,"failed":0,"inputTokens":20,"outputTokens":10,"cachedInputTokens":0,"costUSD":"0.000018000","unknownCostCalls":0}]}}
        """
        let overview = try JSONDecoder().decode(Overview.self, from: Data(json.utf8))
        XCTAssertEqual(overview.slots.map(\.title), ["Worker · 단순", "Main"])
        XCTAssertEqual(overview.slots[0].resolved, "deepseek:b")
        XCTAssertNil(overview.slots[1].resolved)
        XCTAssertEqual(overview.providers[0].models, 62)
        XCTAssertEqual(overview.usage.groups[0].roleLabel, "worker · normal")
    }

    func testFormatUSDKeepsSmallAmountsAndTrimsZeros() {
        XCTAssertEqual(formatUSD("0.000018000"), "$0.000018")
        XCTAssertEqual(formatUSD("12.500000000"), "$12.50")
        XCTAssertEqual(formatUSD("3.000000000"), "$3.00")
        XCTAssertEqual(formatUSD("7"), "$7")
    }

    func testToolLabels() throws {
        let choices = try JSONDecoder().decode([ModelChoice].self, from: Data(#"[{"id":"a","name":"a","tools":"verified"},{"id":"b","name":"b","tools":"unknown"}]"#.utf8))
        XCTAssertEqual(choices.map(\.toolsLabel), ["도구 확인됨", "도구 미확인"])
    }
}
