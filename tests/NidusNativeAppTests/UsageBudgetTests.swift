import XCTest
@testable import NidusNativeApp

final class UsageBudgetTests: XCTestCase {
    private let snapshot = #"{"month":"2026-10","source":"nidus-local-ledger","updatedAt":null,"lastProviderSyncAt":null,"total":{"scope":"total","budgetUSD":"10.000000000","estimatedUSD":"0.100000000","confirmedUSD":null,"reservedUSD":"8.000000000","remainingUSD":"1.900000000","level":"warning","utilizationPercent":81,"unknownCount":1,"unknownPriceCount":1},"providers":[],"requestBudgetUSD":"1.000000000","requests":[],"models":[],"balances":[],"accountReports":[]}"#
    func testDecodePreservesDecimalAndUnknownStates() throws {
        let value = try JSONDecoder().decode(UsageSnapshot.self, from: Data(snapshot.utf8))
        XCTAssertEqual(value.total.estimatedUSD, "0.100000000")
        XCTAssertNil(value.total.confirmedUSD)
        XCTAssertEqual(value.total.unknownCount, 1)
        XCTAssertEqual(value.total.stateLabel, "80% 경고")
        XCTAssertNil(value.lastProviderSyncAt)
    }
    @MainActor func testBudgetSettingsUseCommonRuntimeBridgeAndShowErrors() async {
        var calls: [[String: Any]] = []
        var shouldFail = false
        let data = Data(snapshot.utf8)
        let model = UsageBudgetModel { request in
            calls.append(request)
            if shouldFail { throw DashboardError(message: "Budget Guard denied") }
            return data
        }
        await model.refresh()
        await model.save(scope: "openai", usd: "2.50")
        XCTAssertEqual(calls[0]["method"] as? String, "usage")
        XCTAssertEqual(calls[1]["method"] as? String, "budget-set")
        XCTAssertEqual(calls[1]["scope"] as? String, "openai")
        XCTAssertEqual(calls[1]["usd"] as? String, "2.50")
        await model.syncAccount("anthropic")
        XCTAssertEqual(calls[2]["method"] as? String, "account-sync")
        shouldFail = true
        await model.save(scope: "request", usd: "invalid")
        XCTAssertEqual(model.error, "Budget Guard denied")
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.snapshot?.requestBudgetUSD, "1.000000000")
    }
}
