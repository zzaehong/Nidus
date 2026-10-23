// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "NidusDashboard", platforms: [.macOS(.v13)],
    products: [.executable(name: "NidusNativeApp", targets: ["NidusNativeApp"])],
    targets: [.executableTarget(name: "NidusNativeApp"), .testTarget(name: "NidusNativeAppTests", dependencies: ["NidusNativeApp"], path: "tests/NidusNativeAppTests")])
