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
    @MainActor func testUsageAndAccountSyncUseCommonRuntimeBridgeAndShowErrors() async {
        var calls: [[String: Any]] = []
        var shouldFail = false
        let data = Data(snapshot.utf8)
        let model = UsageBudgetModel { request in
            calls.append(request)
            if shouldFail { throw DashboardError(message: "Usage unavailable") }
            return data
        }
        await model.refresh()
        await model.syncBalance()
        XCTAssertEqual(calls[0]["method"] as? String, "usage")
        XCTAssertEqual(calls[1]["method"] as? String, "balance-sync")
        XCTAssertEqual(calls[1]["provider"] as? String, "deepseek")
        await model.syncAccount("anthropic")
        XCTAssertEqual(calls[2]["method"] as? String, "account-sync")
        shouldFail = true
        await model.refresh()
        XCTAssertEqual(model.error, "Usage unavailable")
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.snapshot?.requestBudgetUSD, "1.000000000")
    }
    @MainActor func testSoftBudgetSaveDeleteAndUnknownUsage() async throws {
        var calls: [[String: Any]] = []
        let model = UsageBudgetModel { request in calls.append(request); return Data(self.snapshot.utf8) }
        await model.setSoftBudget("gemini", usd: "1.123456789")
        await model.setSoftBudget("gemini", usd: nil)
        XCTAssertEqual(calls[0]["method"] as? String, "soft-budget-set")
        XCTAssertEqual(calls[0]["usd"] as? String, "1.123456789")
        XCTAssertTrue(calls[1]["usd"] is NSNull)
        let raw = #"{"provider":"gemini","targetUSD":"1.000000000","updatedAt":null,"usage":{"requests":2,"inputTokens":10,"outputTokens":null,"estimatedUSD":"0.500000000","confirmedUSD":null,"knownSpendUSD":"0.500000000","unknownCostRequests":1},"utilizationPercent":null,"knownUtilizationPercent":50,"state":"incomplete"}"#
        let item = try JSONDecoder().decode(SoftBudgetOverview.self, from: Data(raw.utf8))
        XCTAssertNil(item.utilizationPercent)
        XCTAssertEqual(item.knownUtilizationPercent, 50)
        XCTAssertEqual(item.usage.unknownCostRequests, 1)
    }
}
