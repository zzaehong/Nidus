// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "NidusDashboard", platforms: [.macOS(.v13)],
    products: [
        .executable(name: "Nidus", targets: ["Nidus"]),
        .executable(name: "NidusNativeApp", targets: ["NidusNativeApp"]),
    ],
    targets: [
        // Vault-based app (Nidus.app).
        .executableTarget(name: "Nidus"),
        .testTarget(name: "NidusTests", dependencies: ["Nidus"], path: "tests/NidusTests"),
        // Earlier provider dashboard (Nidus Base.app).
        .executableTarget(name: "NidusNativeApp"),
        .testTarget(name: "NidusNativeAppTests", dependencies: ["NidusNativeApp"], path: "tests/NidusNativeAppTests"),
    ])
