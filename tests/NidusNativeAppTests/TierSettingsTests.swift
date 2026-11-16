import XCTest
@testable import NidusNativeApp

final class TierSettingsTests: XCTestCase {
    private let fixture = #"{"allowPaid":false,"policies":{"simple":[1,2],"normal":[2,1],"complex":[3,2]},"models":[{"provider":"openai","id":"new-model","capabilities":{"chat":"unknown","vision":"unknown","tools":"unknown","streaming":"unknown"},"pricing":{"status":"unknown","sourceUrl":"https://example.test","rates":[]},"tierAssignment":{"tier":0,"source":null,"checkedAt":null,"userModified":false},"health":{"status":"unknown","available":true,"checkedAt":null}}]}"#
    func testSettingsDecodePreservesUnclassifiedAndLegacyPaidFlag() throws {
        let snapshot = try JSONDecoder().decode(RoutingSettingsSnapshot.self, from: Data(fixture.utf8))
        XCTAssertFalse(snapshot.allowPaid)
        XCTAssertEqual(snapshot.policies["complex"], [3, 2])
        XCTAssertEqual(snapshot.models[0].tierAssignment.tier, 0)
        XCTAssertFalse(snapshot.models[0].tierAssignment.userModified)
        XCTAssertEqual(tierLabel(0), "Unclassified")
    }
    @MainActor func testPolicyOrderAndAssignmentResetUseSharedTransport() async throws {
        var calls: [[String: Any]] = []
        var fail = false
        let data = Data(fixture.utf8)
        let model = RoutingSettingsModel { request in
            calls.append(request)
            if fail { throw DashboardError(message: "Save failed") }
            return data
        }
        await model.perform()
        let item = try XCTUnwrap(model.snapshot?.models.first)
        await model.policy("normal", [3, 1])
        await model.assign(item, 2)
        await model.assign(item, nil)
        await model.perform(["method": "routing-policy-set", "difficulty": "simple", "tiers": [1, 2]])
        XCTAssertEqual(calls[1]["tiers"] as? [Int], [3, 1])
        XCTAssertEqual(calls[2]["tier"] as? Int, 2)
        XCTAssertTrue(calls[3]["tier"] is NSNull)
        XCTAssertEqual(calls[4]["tiers"] as? [Int], [1, 2])
        fail = true
        await model.policy("complex", [])
        XCTAssertEqual(model.error, "Save failed")
        XCTAssertEqual(model.snapshot?.policies["complex"], [3, 2])
        XCTAssertFalse(model.busy)
    }
    func testChatRoutingTierAndTransitionDecodeAlongsideLegacyRecords() throws {
        let json = #"{"difficulty":"complex","tier":2,"reason":"fallback","boundUSD":"0.1","transitions":[{"tier":3,"provider":"anthropic","model":"a","reason":"rate_limit","status":"failed","budget":"allowed"},{"tier":2,"provider":"gemini","model":"g","reason":"rate_limit","status":"succeeded","budget":"allowed"}]}"#
        let result = try JSONDecoder().decode(RoutingResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.tier, 2)
        XCTAssertEqual(result.transitions[0].tier, 3)
        let restored = try JSONDecoder().decode(RoutingResult.self, from: JSONEncoder().encode(result))
        XCTAssertEqual(restored.transitions[1].tier, 2)
    }
}
