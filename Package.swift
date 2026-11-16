// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "NidusDashboard", platforms: [.macOS(.v13)],
    products: [.executable(name: "Nidus", targets: ["Nidus"])],
    targets: [
        .executableTarget(name: "Nidus"),
        .testTarget(name: "NidusTests", dependencies: ["Nidus"], path: "tests/NidusTests"),
    ])
