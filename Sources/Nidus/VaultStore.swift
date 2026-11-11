import Foundation
import SwiftUI

/// Progress of a batch model check.
struct BatchProgress: Equatable {
    let provider: String
    let total: Int
    var done = 0
    var current = ""
    var running = true
    var toolsPassed = 0
    var textOnly = 0
    var failed = 0
    var inconclusive = 0

    mutating func record(_ result: CheckResult?) {
        done += 1
        guard let result else { inconclusive += 1; return }
        if result.tools == "passed" { toolsPassed += 1 }
        else if result.text == "passed" { textOnly += 1 }
        else if result.text == "failed" { failed += 1 }
        else { inconclusive += 1 }
    }

    var summary: String {
        "도구까지 통과 \(toolsPassed) · 텍스트만 통과 \(textOnly) · 실패 \(failed) · 판정 보류 \(inconclusive)"
    }
}

/// State of the open vault. Every change goes through the engine and comes back as a fresh overview.
@MainActor
final class VaultStore: ObservableObject {
    @Published private(set) var vault: String?
    @Published private(set) var overview: Overview?
    @Published private(set) var busy = false
    @Published var error: String?
    /// A chosen folder that has no .nidus yet; the user confirms before it is created.
    @Published var pendingInit: String?
    @Published private(set) var batch: BatchProgress?
    /// Bumped whenever a model check is recorded, so model lists know to reload.
    @Published private(set) var checksRevision = 0
    private var batchTask: Task<Void, Never>?
    private var pending = 0

    /// Busy while any request is in flight or a batch is running.
    private func updateBusy() {
        busy = pending > 0 || batch?.running == true
    }

    private let bridge: Bridge
    private let defaults: UserDefaults
    private static let lastVaultKey = "lastVault"

    init(bridge: Bridge = .shared, defaults: UserDefaults = .standard) {
        self.bridge = bridge
        self.defaults = defaults
    }

    private func arguments(_ extra: [String: Any] = [:]) -> [String: Any] {
        var all = extra
        all["vault"] = vault
        return all
    }

    /// Runs one engine action, tracking the busy state and surfacing failures.
    @discardableResult
    private func run<T>(_ action: () async throws -> T) async -> T? {
        pending += 1
        updateBusy()
        defer {
            pending -= 1
            updateBusy()
        }
        do {
            return try await action()
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    func restoreLastVault() async {
        guard vault == nil, let path = defaults.string(forKey: Self.lastVaultKey) else { return }
        await open(path, quietly: true)
    }

    func open(_ path: String, quietly: Bool = false) async {
        let status: VaultStatus? = await run { try await bridge.call("vault-status", ["vault": path]) }
        guard let status else { return }
        guard status.exists else {
            if !quietly { error = "폴더를 찾을 수 없습니다." }
            return
        }
        if status.initialized {
            vault = status.vault
            defaults.set(status.vault, forKey: Self.lastVaultKey)
            await reload()
        } else if !quietly {
            pendingInit = status.vault
        }
    }

    func initialize(_ path: String) async {
        let created: Bool = await run {
            let _: Acknowledgement = try await bridge.call("vault-init", ["vault": path])
            return true
        } ?? false
        if created { await open(path) }
    }

    func close() {
        vault = nil
        overview = nil
        defaults.removeObject(forKey: Self.lastVaultKey)
    }

    func reload() async {
        guard vault != nil else { return }
        if let fresh: Overview = await run({ try await bridge.call("overview", arguments()) }) { overview = fresh }
    }

    func setCandidates(_ slot: Slot, _ candidates: [String]) async {
        if let fresh: Overview = await run({ try await bridge.call("set-candidates", arguments(["slot": slot.id, "candidates": candidates])) }) {
            overview = fresh
        }
    }

    func setBudget(_ monthlyUSD: String?) async {
        if let fresh: Overview = await run({ try await bridge.call("set-budget", arguments(["monthlyUSD": monthlyUSD ?? NSNull()])) }) {
            overview = fresh
        }
    }

    /// Returns true when the key was accepted and stored.
    func connect(_ provider: ProviderInfo, key: String, accountId: String) async -> Bool {
        var extra: [String: Any] = ["provider": provider.id, "key": key]
        if provider.needsAccountId { extra["accountId"] = accountId }
        let result: ConnectResult? = await run { try await bridge.call("connect", arguments(extra)) }
        if result != nil { await reload() }
        return result != nil
    }

    func refresh(_ provider: ProviderInfo) async {
        let result: ConnectResult? = await run { try await bridge.call("refresh", arguments(["provider": provider.id])) }
        if result != nil { await reload() }
    }

    func disconnect(_ provider: ProviderInfo) async {
        let done: Acknowledgement? = await run { try await bridge.call("disconnect", arguments(["provider": provider.id])) }
        if done != nil { await reload() }
    }

    func models(_ provider: String) async -> [ModelChoice] {
        await run { try await bridge.call("models", arguments(["provider": provider])) } ?? []
    }

    /// Checks one model with real calls and refreshes the lists that depend on the result.
    func check(provider: String, model: String) async -> CheckResult? {
        let result: CheckResult? = await run { try await bridge.call("check", arguments(["provider": provider, "model": model])) }
        if result != nil {
            checksRevision += 1
            await reload()
        }
        return result
    }

    /// Checks the given models one after another. Only one batch runs at a time.
    func startBatch(provider: String, models: [String]) {
        guard batch?.running != true, !models.isEmpty else { return }
        batch = BatchProgress(provider: provider, total: models.count)
        updateBusy()
        batchTask = Task {
            for model in models {
                if Task.isCancelled { break }
                batch?.current = model
                let result: CheckResult? = try? await bridge.call("check", arguments(["provider": provider, "model": model]))
                batch?.record(result)
                checksRevision += 1
                // A short gap keeps a long run under per-minute request limits.
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            batch?.running = false
            updateBusy()
            await reload()
        }
    }

    func stopBatch() {
        batchTask?.cancel()
    }

    func dismissBatch() {
        if batch?.running == false { batch = nil }
    }

    func ask(slot: Slot, prompt: String, system: String) async -> AskResult? {
        var extra: [String: Any] = ["role": slot.role, "prompt": prompt, "system": system]
        if let difficulty = slot.difficulty { extra["difficulty"] = difficulty }
        let result: AskResult? = await run { try await bridge.call("ask", arguments(extra)) }
        if result != nil { await reload() }
        return result
    }
}
