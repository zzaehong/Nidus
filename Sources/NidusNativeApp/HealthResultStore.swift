import Foundation

/// Local metadata only: no credentials, prompts, or generated responses.
struct HealthResultStore {
    let url: URL
    static var application: HealthResultStore {
        HealthResultStore(url: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Nidus", isDirectory: true).appendingPathComponent("model-health.json"))
    }
    private struct Snapshot: Codable {
        let version: Int
        let results: [HealthRow]
    }
    func load() throws -> [HealthRow] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: url))
        guard snapshot.version == 1, snapshot.results.allSatisfy({
            ($0.status == .passed || $0.status == .failed) && $0.checkedAt != nil
        }), Set(snapshot.results.map(\.id)).count == snapshot.results.count else {
            throw DashboardError(message: "검사 기록 형식이 올바르지 않습니다.")
        }
        return snapshot.results
    }
    func save(_ rows: [HealthRow]) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let completed = rows.filter { ($0.status == .passed || $0.status == .failed) && $0.checkedAt != nil }
        let data = try JSONEncoder().encode(Snapshot(version: 1, results: completed.sorted { $0.id < $1.id }))
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
