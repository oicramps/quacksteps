// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "QuackPackages",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "QuackProtocol", targets: ["QuackProtocol"]),
        .library(name: "QuackClient", targets: ["QuackClient"]),
        .library(name: "QuackStores", targets: ["QuackStores"]),
        .library(name: "QuackUI", targets: ["QuackUI"]),
        .executable(name: "Quacksteps", targets: ["Quacksteps"]),
        .executable(name: "quack-launchd-spike", targets: ["LaunchdSpike"]),
    ],
    targets: [
        .target(
            name: "QuackProtocol",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "QuackClient",
            dependencies: ["QuackProtocol"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "QuackStores",
            dependencies: ["QuackProtocol", "QuackClient"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "QuackUI",
            dependencies: ["QuackProtocol", "QuackClient", "QuackStores"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "Quacksteps",
            dependencies: ["QuackProtocol", "QuackClient", "QuackStores", "QuackUI"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "QuackSnapshots",
            dependencies: ["QuackProtocol", "QuackClient", "QuackStores", "QuackUI"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "LaunchdSpike",
            dependencies: ["QuackClient"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "QuackProtocolTests",
            dependencies: ["QuackProtocol"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "QuackStoresTests",
            dependencies: ["QuackStores"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "QuackClientTests",
            dependencies: ["QuackClient"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
