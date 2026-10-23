// Security.framework bridge only; API engine and CLI remain TypeScript.
import Foundation
import Security

func run() throws {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 65536,
          let request = try JSONSerialization.jsonObject(with: data) as? [String: String],
          let provider = request["provider"], ["openai", "anthropic", "gemini", "deepseek"].contains(provider),
          let action = request["action"] else { throw NSError(domain: "nidus", code: 1) }
    let service = request["service"] ?? "com.nidus.connectivity"
    guard service == "com.nidus.connectivity" || service.hasPrefix("com.nidus.connectivity.test.") else { throw NSError(domain: "nidus", code: 4) }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: provider,
        kSecAttrSynchronizable as String: false]
    var result: [String: String] = [:]
    switch action {
    case "get":
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &value)
        if status == errSecSuccess, let bytes = value as? Data, let key = String(data: bytes, encoding: .utf8) { result["key"] = key }
        else if status != errSecItemNotFound { throw NSError(domain: "keychain", code: Int(status)) }
    case "set":
        guard let key = request["key"], !key.isEmpty else { throw NSError(domain: "nidus", code: 2) }
        let attributes = [kSecValueData as String: Data(key.utf8)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addition = query.merging(attributes) { _, new in new }
            addition[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(addition as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NSError(domain: "keychain", code: Int(status)) }
    case "delete":
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NSError(domain: "keychain", code: Int(status)) }
    default: throw NSError(domain: "nidus", code: 3)
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
}
do { try run() } catch { exit(1) } // No key or OS error text is emitted.
