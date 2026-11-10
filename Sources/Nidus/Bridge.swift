import Foundation
import Darwin

struct BridgeError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Locates Node and the compiled gateway bridge: explicit environment, app bundle, working directory, then the source checkout.
struct BridgeLocation {
    let node: URL
    let script: URL

    static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> BridgeLocation {
        let files = FileManager.default
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let roots = [
            environment["NIDUS_RUNTIME_ROOT"].map { URL(fileURLWithPath: $0) },
            Bundle.main.resourceURL,
            URL(fileURLWithPath: files.currentDirectoryPath),
            sourceRoot,
        ].compactMap { $0 }

        guard let script = roots
            .map({ $0.appendingPathComponent("dist/gateway/bridge.js") })
            .first(where: { files.fileExists(atPath: $0.path) })
        else {
            throw BridgeError(message: "엔진을 찾을 수 없습니다. 저장소에서 npm run build를 실행하거나 NIDUS_RUNTIME_ROOT를 지정하세요.")
        }

        let nodeCandidates = [environment["NIDUS_NODE_PATH"], Bundle.main.resourceURL?.appendingPathComponent("bin/node").path].compactMap { $0 }
            + (environment["PATH"] ?? "").split(separator: ":").map { "\($0)/node" }
            + ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        guard let node = nodeCandidates.first(where: { files.isExecutableFile(atPath: $0) }) else {
            throw BridgeError(message: "Node.js 22.13 이상이 필요합니다. NIDUS_NODE_PATH에 node의 절대 경로를 지정하세요.")
        }

        let keychain = script.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("nidus-keychain")
        guard files.isExecutableFile(atPath: keychain.path) else {
            throw BridgeError(message: "Keychain helper가 없습니다. npm run build:keychain을 실행하세요.")
        }
        return BridgeLocation(node: URL(fileURLWithPath: node), script: script)
    }
}

/// Runs one engine request per child process. Requests (which can carry an API key) go over stdin only.
final class Bridge: @unchecked Sendable {
    static let shared = Bridge()

    private let lock = NSLock()
    private var children: [UUID: Process] = [:]
    private var closed = false
    private let locate: () throws -> BridgeLocation
    private let deadline: TimeInterval

    init(locate: @escaping () throws -> BridgeLocation = { try BridgeLocation.resolve() }, deadline: TimeInterval = 300) {
        self.locate = locate
        self.deadline = deadline
    }

    func call<Result: Decodable>(_ method: String, _ arguments: [String: Any] = [:]) async throws -> Result {
        var request = arguments
        request["method"] = method
        let input = try JSONSerialization.data(withJSONObject: request)
        let output = try await Task.detached { try self.execute(input) }.value
        do {
            return try JSONDecoder().decode(Result.self, from: output)
        } catch {
            throw BridgeError(message: "엔진 응답 형식이 예상과 다릅니다.")
        }
    }

    /// Stops running requests when the app quits.
    func shutdown() {
        lock.lock()
        closed = true
        let running = Array(children.values)
        lock.unlock()
        running.forEach(Self.stop)
    }

    private static func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    private func execute(_ input: Data) throws -> Data {
        let location = try locate()
        let process = Process(), stdin = Pipe(), stdout = Pipe(), id = UUID()
        process.executableURL = location.node
        process.arguments = [location.script.path]
        process.standardInput = stdin
        process.standardOutput = stdout
        // Provider errors and credentials must never reach app logs.
        process.standardError = FileHandle.nullDevice

        lock.lock()
        if closed {
            lock.unlock()
            throw BridgeError(message: "앱이 종료 중입니다.")
        }
        do {
            try process.run()
            children[id] = process
            lock.unlock()
        } catch {
            lock.unlock()
            throw BridgeError(message: "엔진 프로세스를 실행할 수 없습니다.")
        }

        let watchdog = DispatchWorkItem { Self.stop(process) }
        DispatchQueue.global().asyncAfter(deadline: .now() + deadline, execute: watchdog)
        defer {
            watchdog.cancel()
            try? stdout.fileHandleForReading.close()
            lock.lock()
            children.removeValue(forKey: id)
            lock.unlock()
        }

        do {
            try stdin.fileHandleForWriting.write(contentsOf: input)
            try stdin.fileHandleForWriting.close()
        } catch {
            Self.stop(process)
            throw BridgeError(message: "엔진에 요청을 전달하지 못했습니다.")
        }

        var output = Data()
        while let chunk = try stdout.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
            output.append(chunk)
            if output.count > 32 * 1024 * 1024 {
                Self.stop(process)
                throw BridgeError(message: "엔진 응답이 너무 큽니다.")
            }
        }
        process.waitUntilExit()

        guard process.terminationStatus == 0,
              let envelope = try? JSONSerialization.jsonObject(with: output) as? [String: Any]
        else {
            throw BridgeError(message: "엔진이 응답하지 않았거나 시간이 초과되었습니다.")
        }
        if let error = envelope["error"] as? [String: Any] {
            throw BridgeError(message: "[\(error["code"] as? String ?? "error")] \(error["message"] as? String ?? "요청 실패")")
        }
        guard let result = envelope["result"] else {
            throw BridgeError(message: "엔진 응답이 비어 있습니다.")
        }
        return try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
    }
}
