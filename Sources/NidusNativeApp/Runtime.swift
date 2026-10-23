import Foundation
import Darwin

struct DashboardError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct RuntimeLocation {
    let node: URL
    let script: URL
    static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> RuntimeLocation {
        let fm = FileManager.default
        let sourceRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let roots = [environment["NIDUS_RUNTIME_ROOT"].map { URL(fileURLWithPath: $0) }, Bundle.main.resourceURL,
                     URL(fileURLWithPath: fm.currentDirectoryPath), sourceRoot].compactMap { $0 }
        guard let script = roots.map({ $0.appendingPathComponent("dist/dashboard.js") }).first(where: { fm.fileExists(atPath: $0.path) }) else {
            throw DashboardError(message: "Runtime을 찾을 수 없습니다. 저장소에서 npm run build를 실행하거나 NIDUS_RUNTIME_ROOT를 지정하세요.")
        }
        let candidates = [environment["NIDUS_NODE_PATH"], Bundle.main.resourceURL?.appendingPathComponent("bin/node").path].compactMap { $0 }
            + (environment["PATH"] ?? "").split(separator: ":").map { "\($0)/node" }
            + ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        guard let node = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) else {
            throw DashboardError(message: "Node.js 22 이상이 필요합니다. Node가 활성화된 터미널에서 실행하거나 NIDUS_NODE_PATH에 node의 절대 경로를 지정하세요.")
        }
        guard fm.isExecutableFile(atPath: script.deletingLastPathComponent().appendingPathComponent("nidus-keychain").path) else {
            throw DashboardError(message: "Keychain helper가 없습니다. npm run build:keychain을 실행하세요.")
        }
        return RuntimeLocation(node: URL(fileURLWithPath: node), script: script)
    }
}

final class Runtime: @unchecked Sendable {
    static let shared = Runtime()
    private let lock = NSLock()
    private var children: [UUID: Process] = [:]
    private var closed = false
    private let locate: () throws -> RuntimeLocation
    private let deadline: TimeInterval
    init(locate: @escaping () throws -> RuntimeLocation = { try RuntimeLocation.resolve() }, deadline: TimeInterval = 245) {
        self.locate = locate; self.deadline = deadline
    }

    func shutdown() {
        lock.lock(); closed = true; let running = Array(children.values); lock.unlock()
        running.forEach { if $0.isRunning { $0.terminate() } }
        if !running.isEmpty {
            let limit = Date().addingTimeInterval(1)
            while running.contains(where: { $0.isRunning }) && Date() < limit { Thread.sleep(forTimeInterval: 0.02) }
            running.forEach { if $0.isRunning { kill($0.processIdentifier, SIGKILL) } }
        }
    }
    private static func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
    func call(_ request: [String: Any]) async throws -> Data {
        let input = try JSONSerialization.data(withJSONObject: request)
        guard input.count <= 1_048_576 else { throw DashboardError(message: "요청이 너무 큽니다.") }
        return try await Task.detached { try self.execute(input) }.value
    }
    private func execute(_ input: Data) throws -> Data {
        let location = try locate()
        let process = Process(), stdin = Pipe(), stdout = Pipe(), id = UUID()
        process.executableURL = location.node
        process.arguments = [location.script.path]
        process.currentDirectoryURL = location.script.deletingLastPathComponent().deletingLastPathComponent()
        process.standardInput = stdin; process.standardOutput = stdout
        // Never forward provider errors or credentials into app logs.
        process.standardError = FileHandle.nullDevice
        lock.lock()
        if closed { lock.unlock(); throw DashboardError(message: "앱이 종료 중입니다.") }
        do { try process.run(); children[id] = process; lock.unlock() }
        catch { lock.unlock(); throw DashboardError(message: "Runtime 프로세스를 실행할 수 없습니다.") }
        let watchdog = DispatchWorkItem { Self.stop(process) }
        DispatchQueue.global().asyncAfter(deadline: .now() + deadline, execute: watchdog)
        defer {
            watchdog.cancel()
            try? stdin.fileHandleForWriting.close(); try? stdout.fileHandleForReading.close()
            lock.lock(); children.removeValue(forKey: id); lock.unlock()
        }
        do { try stdin.fileHandleForWriting.write(contentsOf: input); try stdin.fileHandleForWriting.close() }
        catch { Self.stop(process); throw DashboardError(message: "Runtime에 요청을 전달하지 못했습니다.") }
        var output = Data()
        while let chunk = try stdout.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
            output.append(chunk)
            if output.count > 32 * 1024 * 1024 { Self.stop(process); throw DashboardError(message: "Runtime 응답 크기를 초과했습니다.") }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw DashboardError(message: "Runtime이 종료되었거나 요청 시간이 초과되었습니다. 다시 연결하세요.") }
        guard let envelope = try? JSONSerialization.jsonObject(with: output) as? [String: Any] else {
            throw DashboardError(message: "Runtime 응답을 해석하지 못했습니다.")
        }
        if let error = envelope["error"] as? [String: Any] {
            throw DashboardError(message: "[\(error["code"] as? String ?? "error")] \(error["message"] as? String ?? "요청 실패")")
        }
        guard let result = envelope["result"] else { throw DashboardError(message: "Runtime 응답이 비어 있습니다.") }
        return try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    }
}
