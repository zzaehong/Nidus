import XCTest
@testable import NidusNativeApp

final class FreeUseAndDragTests: XCTestCase {
    func testDragReordersOnlyWithinSameDifficultyAndPreservesMembership() {
        XCTAssertEqual(reorderedTiers([1, 2, 3], difficulty: "simple", payloads: ["nidus-tier:simple:1"], target: 3), [2, 3, 1])
        XCTAssertEqual(reorderedTiers([3, 2, 1], difficulty: "complex", payloads: ["nidus-tier:complex:1"], target: 3), [1, 3, 2])
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["nidus-tier:simple:1"], target: 2))
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["nidus-tier:normal:3"], target: 2))
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["unrelated text"], target: 2))
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["nidus-tier:normal:1"], target: 1))
        XCTAssertNil(reorderedTiers([1, 2], difficulty: "normal", payloads: ["nidus-tier:normal:1", "nidus-tier:normal:2"], target: 2))
    }
    @MainActor func testDroppedOrderAndScopedRiskConsentUseCommonBridgeAndDoNotOptimisticallySave() async throws {
        let raw = #"{"allowPaid":false,"policies":{"simple":[1,2],"normal":[2,1],"complex":[3,2]},"models":[]}"#
        var calls: [[String: Any]] = []
        var fail = false
        let model = RoutingSettingsModel { input in
            calls.append(input)
            if fail { throw DashboardError(message: "Storage failure") }
            return Data(raw.utf8)
        }
        await model.perform()
        let reordered = try XCTUnwrap(reorderedTiers([1, 2], difficulty: "simple", payloads: ["nidus-tier:simple:1"], target: 2))
        fail = true
        await model.policy("simple", reordered)
        XCTAssertEqual(calls[1]["tiers"] as? [Int], [2, 1])
        XCTAssertEqual(model.snapshot?.policies["simple"], [1, 2])
        XCTAssertEqual(model.error, "Storage failure")
        fail = false
        await model.perform(["method": "free-use-set", "provider": "gemini", "model": "gemini-2.5-flash", "status": "unverified", "approved": true, "accountConfirmed": false, "chargeRiskAccepted": true])
        XCTAssertEqual(calls[2]["chargeRiskAccepted"] as? Bool, true)
        XCTAssertEqual(calls[2]["status"] as? String, "unverified")
        XCTAssertFalse(model.snapshot!.allowPaid)
    }
    func testUserAttestationAndUnknownQuotaAreDisplayedWithoutClaimingProviderVerification() throws {
        let raw = #"{"status":"verified","approved":true,"checkedAt":"2026-10-25T00:00:00Z","source":"https://ai.google.dev/gemini-api/docs/pricing","conditions":"Quota not synchronized; paid bounds apply","verification":"user-account-attestation"}"#
        let result = try JSONDecoder().decode(RoutingSettingsSnapshot.TierModel.FreeUse.self, from: Data(raw.utf8))
        XCTAssertEqual(result.verification, "user-account-attestation")
        XCTAssertEqual(result.status, "verified")
        XCTAssertTrue(result.conditions.contains("paid bounds"))
        XCTAssertNotNil(result.checkedAt)
    }
    @MainActor func testGeminiProjectSettingUsesSharedBridgeWithoutEnablingPaidRouting() async throws {
        var sent: [String: Any] = [:]
        let model = RoutingSettingsModel { input in
            sent = input
            return Data(#"{"allowPaid":false,"policies":{"normal":[2,1]},"models":[],"geminiBilling":{"state":"free","project":"test-project","checkedAt":"2026-10-25T00:00:00Z"}}"#.utf8)
        }
        await model.perform(["method": "gemini-billing-set", "state": "free", "project": "test-project", "confirmed": true, "riskAccepted": true])
        XCTAssertEqual(sent["method"] as? String, "gemini-billing-set")
        XCTAssertEqual(model.snapshot?.geminiBilling?.state, "free")
        XCTAssertEqual(model.snapshot?.geminiBilling?.project, "test-project")
        XCTAssertEqual(model.snapshot?.allowPaid, false)
    }
    @MainActor func testBulkFreeStatusStopsOnFailureAndRetriesOnlyRemainingWithoutPaidApproval() async throws {
        let template = #"{"provider":"gemini","id":"MODEL","capabilities":{"chat":"supported","vision":"unknown","tools":"unknown","streaming":"unknown"},"pricing":{"status":"known","sourceUrl":"https://example.test","freeTier":"available","rates":[]},"tierAssignment":{"tier":2,"source":null,"checkedAt":null,"userModified":false},"health":{"status":"unknown","available":true,"checkedAt":null}}"#
        let models = try ["first", "second", "third"].map { id in
            try JSONDecoder().decode(RoutingSettingsSnapshot.TierModel.self, from: Data(template.replacingOccurrences(of: "MODEL", with: id).utf8))
        }
        let unknown = try JSONDecoder().decode(RoutingSettingsSnapshot.TierModel.self, from: Data(template.replacingOccurrences(of: #""freeTier":"available""#, with: #""freeTier":"unknown""#).utf8))
        XCTAssertEqual(freeStatusSelection(models + [unknown]), Set(models.map(\.id)))
        var calls: [[String: Any]] = []
        var fail = true
        let model = RoutingSettingsModel { input in
            calls.append(input)
            if fail && input["model"] as? String == "second" { throw DashboardError(message: "Storage unavailable") }
            return Data(#"{"allowPaid":false,"policies":{},"models":[]}"#.utf8)
        }
        let saved = await model.recordFreeUse(models, status: "verified", confirmed: true, completed: [])
        XCTAssertEqual(saved, ["gemini:first"])
        XCTAssertEqual(calls.count, 2)
        XCTAssertNotNil(model.error)
        XCTAssertFalse(model.busy)
        fail = false
        let retried = await model.recordFreeUse(models, status: "verified", confirmed: true, completed: saved)
        XCTAssertEqual(retried, Set(models.map(\.id)))
        XCTAssertEqual(calls.compactMap { $0["model"] as? String }, ["first", "second", "second", "third"])
        XCTAssertNil(model.error)
        for call in calls {
            XCTAssertEqual(call["method"] as? String, "free-use-set")
            XCTAssertEqual(call["approved"] as? Bool, false)
            XCTAssertEqual(call["chargeRiskAccepted"] as? Bool, false)
            XCTAssertEqual(call["accountConfirmed"] as? Bool, true)
        }
    }
}
