// Renders the M2 screens to PNG, in light and dark, with synthetic data (modelled on the screens canvas).
//
//   swift run QuackSnapshots <output-folder>
//
// For checking layouts without a screen: the views are hosted in off-screen windows and cached to bitmaps.
import AppKit
import QuackClient
import QuackProtocol
import QuackStores
import QuackUI
import SwiftUI
import WebKit

let out = URL(filePath: CommandLine.arguments.dropFirst().first ?? FileManager.default.currentDirectoryPath)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

let now = Date()
func iso(hoursAgo: Double) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(-hoursAgo * 3600)) }
func decode<T: Decodable>(_ json: String) -> T { try! JSONDecoder().decode(T.self, from: Data(json.utf8)) }

let sha = "a41c9e2b7d3f4e5a6b7c8d9e0f1a2b3c4d5e6f7a"
func item(_ n: Int, _ repo: String, _ title: String, _ author: String, role: String, adds: Int, dels: Int, ci: String, hours: Double,
          via: String = "user", team: String? = nil, state: String? = nil, reasons: [String] = [], review: String? = nil, draft: Bool = false, stack: String? = nil, approvedBy: String? = nil) -> String {
    let approved = approvedBy.map { #","approvedBy":["\#($0)"]"# } ?? ""
    let reviewer = role == "reviewer" ? #","reviewer":{"requestedAt":"\#(iso(hoursAgo: hours))","via":"\#(via)"\#(team.map { #","team":"\#($0)""# } ?? "")\#(approved)}"# : ""
    let authorPart = role == "author" ? #","author":{"state":\#(state.map { "\"\($0)\"" } ?? "null"),"since":"\#(iso(hoursAgo: hours))","reasons":\#(try! String(decoding: JSONEncoder().encode(reasons), as: UTF8.self))}"# : ""
    let reviewPart = review.map { #","review":{"startedAt":"\#(iso(hoursAgo: 1))","headSha":"\#(sha)","latestHeadSha":"\#(sha)","worktreePath":"/tmp/wt","phase":"\#($0)","labels":"ready"}"# } ?? ""
    return #"{"pr":{"owner":"acme","repo":"\#(repo)","number":\#(n)},"title":"\#(title)","url":"https://github.com/acme/\#(repo)/pull/\#(n)","authorLogin":"\#(author)","isDraft":\#(draft),"headSha":"\#(sha)","baseRef":"main","updatedAt":"\#(iso(hoursAgo: 1))","additions":\#(adds),"deletions":\#(dels),"role":"\#(role)","ci":"\#(ci)"\#(reviewer)\#(authorPart)\#(reviewPart)\#(stack.map { #","stack":\#($0)"# } ?? ""),"ownerType":"org"}"#
}

let items = [
    item(4131, "web", "Bump vite to 6.2", "bram-dewit", role: "reviewer", adds: 12, dels: 12, ci: "passing", hours: 98, review: "stale"),
    item(4127, "web", "Trip map: cluster pins at low zoom", "noor-haddad", role: "reviewer", adds: 412, dels: 88, ci: "passing", hours: 53, review: "ready", stack: #"{"position":1,"size":2}"#),
    item(4129, "web", "Trip map: tap a cluster to expand it", "noor-haddad", role: "reviewer", adds: 64, dels: 9, ci: "passing", hours: 3.67, stack: #"{"position":2,"size":2,"parent":{"number":4127,"title":"Trip map: cluster pins at low zoom"}}"#),
    item(882, "api", "Rate-limit photo uploads per traveller", "joris-vandalen", role: "reviewer", adds: 156, dels: 20, ci: "pending", hours: 6.2, via: "team", team: "backend", approvedBy: "sven-aaltonen"),
    item(2210, "android", "Fix crash when a trip has no cover photo", "ines-moreau", role: "reviewer", adds: 34, dels: 6, ci: "passing", hours: 1.17),
    item(1290, "ios", "Offline step drafts survive an app restart", "mila-okafor", role: "reviewer", adds: 903, dels: 340, ci: "failing", hours: 0.42, review: "preparing"),
    item(879, "api", "Trip export: stream GPX instead of buffering", "dev", role: "author", adds: 40, dels: 3, ci: "failing", hours: 3, state: "waiting_on_me", reasons: ["Changes requested by sven-aaltonen", "2 unresolved threads"]),
    item(4119, "web", "Step editor: autosave every 10 seconds", "dev", role: "author", adds: 80, dels: 12, ci: "passing", hours: 30, state: "waiting_on_reviewers", reasons: ["Requested noor-haddad, priya-raman"]),
    item(4122, "web", "Remove the legacy feed endpoint", "dev", role: "author", adds: 5, dels: 300, ci: "failing", hours: 0.67, state: "blocked_by_ci", reasons: ["e2e failed on 3c9d01f"]),
    item(875, "api", "Add index on steps (trip_id, taken_at)", "dev", role: "author", adds: 12, dels: 0, ci: "passing", hours: 2, state: "ready_to_merge", reasons: ["Approved by joris-vandalen"]),
    item(1284, "ios", "SwiftData migration spike", "dev", role: "author", adds: 400, dels: 0, ci: "none", hours: 50, draft: true),
]
let inbox: InboxMessage = decode(#"{"requestId":"s","fetchedAt":"\#(iso(hoursAgo: 0.011))","items":[\#(items.joined(separator: ","))],"events":[],"more":{"reviewer":0,"author":0}}"#)
let hello: HelloResponse = decode(#"{"requestId":"h","version":"0.2.6","protocol":2,"viewer":"dev","capabilities":{"workspace":true,"inbox":true,"labels":true,"review":true,"agents":["cursor","claude-code"]}}"#)
let checks: [SetupCheck] = decode(#"""
[{"id":"server","ok":true,"title":"Quack server is running","detail":"quackd 0.2.6 at ~/.quack/run/quack.sock","fixSteps":[]},
 {"id":"gh","ok":false,"title":"GitHub CLI can see polarsteps","detail":"Logged in as dev, but not authorised for the polarsteps org’s single sign-on. Org PRs would be missing.","fixSteps":[{"text":"Run the command below. It opens github.com in your browser."},{"text":"Next to polarsteps, click Authorize."},{"text":"Come back and click Re-check.","command":"gh auth refresh -h github.com"}]},
 {"id":"git","ok":true,"title":"git is available","detail":"git 2.47.1 at /opt/homebrew/bin/git","fixSteps":[]},
 {"id":"agent","ok":true,"title":"An agent is ready","detail":"Cursor 2026.11.01 is ready. Claude Code isn’t installed; that’s fine.","fixSteps":[]},
 {"id":"clone","ok":false,"title":"Found a clone","detail":"No clones in ~/code yet.","fixSteps":[{"text":"Choose the folder where you keep your clones, or clone one now.","command":"git clone git@github.com:polarsteps/web.git ~/code/web"}]}]
"""#)
let settings: SettingsMessage = decode(#"""
{"requestId":"g","settings":{"scanRoots":["\#(NSHomeDirectory())/code"],"repoPaths":{},"worktreeRoot":"\#(NSHomeDirectory())/.quack/worktrees","retentionDays":7,"maxWorktrees":20,"chatAgent":"cursor","chatModel":"","labelsAgent":null,"labelsModel":"","extraPath":[],"pollActiveSeconds":60,"pollIdleSeconds":300},
 "server":{"version":"0.2.6","pid":4182,"startedAt":"\#(iso(hoursAgo: 2))","socketPath":"\#(NSHomeDirectory())/.quack/run/quack.sock","logPath":"\#(NSHomeDirectory())/.quack/logs/server.log"},
 "github":{"viewer":"dev","rateLimit":{"limit":5000,"remaining":4812,"resetAt":"\#(iso(hoursAgo: -0.5))"}},
 "worktrees":{"root":"\#(NSHomeDirectory())/.quack/worktrees","count":14,"bytes":6657199308},
 "clones":[{"repo":"acme/web","path":"\#(NSHomeDirectory())/code/web"},{"repo":"acme/api","path":"\#(NSHomeDirectory())/code/api"},{"repo":"acme/android","path":null}]}
"""#)
let agents: [AgentStatus] = decode(#"[{"id":"cursor","label":"Cursor","state":"ready","version":"2026.11.01","models":["","auto","sonnet-4"],"fixSteps":[]},{"id":"claude-code","label":"Claude Code","state":"not_installed","models":[],"fixSteps":[{"text":"Install Claude Code","command":"npm i -g @anthropic-ai/claude-code"}]}]"#)

@MainActor
func findWebView(_ view: NSView) -> WKWebView? {
    if let web = view as? WKWebView { return web }
    for sub in view.subviews { if let found = findWebView(sub) { return found } }
    return nil
}

@MainActor
func snapshot(_ name: String, size: CGSize, @ViewBuilder _ view: () -> some View) {
    for (mode, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
        let host = NSHostingView(rootView: view().frame(width: size.width, height: size.height).background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        window.appearance = appearance
        window.contentView = host
        window.setFrameOrigin(CGPoint(x: -10_000, y: -10_000))
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        // Web views draw in another process: wait for the renderer, then use WebKit's own snapshot.
        if let web = findWebView(host) {
            for _ in 0 ..< 40 {
                RunLoop.main.run(until: Date().addingTimeInterval(0.1))
                if !web.isLoading { break }
            }
            RunLoop.main.run(until: Date().addingTimeInterval(1.5))
            var done = false
            web.takeSnapshot(with: nil) { image, error in
                if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                    try? rep.representation(using: .png, properties: [:])?.write(to: out.appending(path: "\(name)-web-\(mode).png"))
                } else {
                    print("web snapshot failed:", error.map { "\($0)" } ?? "no image")
                }
                done = true
            }
            while !done { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        }
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { continue }
        host.cacheDisplay(in: host.bounds, to: rep)
        try! rep.representation(using: .png, properties: [:])!.write(to: out.appending(path: "\(name)-\(mode).png"))
        window.orderOut(nil)
    }
    print("wrote", name)
}

/// Self-check: the sidebar's AppKit table should have "Everything" (row 0) selected by default.
@MainActor
func sidebarSelfCheck(_ view: some View) {
    let host = NSHostingView(rootView: view.frame(width: 1120, height: 700))
    let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 1120, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = host
    window.setFrameOrigin(CGPoint(x: -10_000, y: -10_000))
    window.orderFront(nil)
    RunLoop.main.run(until: Date().addingTimeInterval(1.0))
    func tables(_ v: NSView) -> [NSTableView] { (v as? NSTableView).map { [$0] } ?? [] + v.subviews.flatMap(tables) }
    for (i, t) in tables(host).enumerated() { print("table \(i): rows \(t.numberOfRows), selected row \(t.selectedRow)") }
    window.orderOut(nil)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    QuackFont.register(from: URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../../extension/assets/fonts").standardized)

    let model = AppModel(preview: inbox, connection: .connected(hello), checks: checks, settings: settings, agents: agents)
    let offline = AppModel(preview: nil, connection: .disconnected(reason: "no socket"))
    let empty = AppModel(preview: decode(#"{"requestId":"s","fetchedAt":"\#(iso(hoursAgo: 0.01))","items":[],"events":[]}"#), connection: .connected(hello))
    let prefs = NotificationPrefs(defaults: UserDefaults(suiteName: "quack-snapshots")!)

    if ProcessInfo.processInfo.environment["QUACK_SIDEBAR_CHECK"] != nil {
        sidebarSelfCheck(InboxView(model: model, openPR: { _ in }, openSetup: {}))
        exit(0)
    }
    let ws = Workspace(defaults: UserDefaults(suiteName: "quack-snapshots-ws")!)
    ws.open(PrKey(owner: "acme", repo: "web", number: 4127))
    ws.open(PrKey(owner: "acme", repo: "web", number: 4131))
    snapshot("main-pr-tab", size: CGSize(width: 1240, height: 640)) { InboxView(model: model, workspace: ws, openPR: { ws.open($0) }, openSetup: {}) }
    let filtered = AppModel(preview: inbox, connection: .connected(hello), checks: checks, settings: settings, agents: agents)
    filtered.useVisibilityDefaults(UserDefaults(suiteName: "quack-snapshots-hidden")!)
    filtered.setRepo("acme/android", hidden: true)
    snapshot("inbox-filtered", size: CGSize(width: 1120, height: 820)) { InboxView(model: filtered, openPR: { _ in }, openSetup: {}) }
    let scoped = AppModel(preview: inbox, connection: .connected(hello), checks: checks, settings: settings, agents: agents)
    scoped.useVisibilityDefaults(UserDefaults(suiteName: "quack-snapshots-scope")!)
    scoped.setAccountScope("acme")
    snapshot("inbox-scoped", size: CGSize(width: 1120, height: 820)) { InboxView(model: scoped, openPR: { _ in }, openSetup: {}) }
    snapshot("inbox", size: CGSize(width: 1120, height: 820)) { InboxView(model: model, openPR: { _ in }, openSetup: {}) }
    snapshot("inbox-offline", size: CGSize(width: 1120, height: 560)) { InboxView(model: offline, openPR: { _ in }, openSetup: {}) }
    snapshot("inbox-empty", size: CGSize(width: 1120, height: 560)) { InboxView(model: empty, openPR: { _ in }, openSetup: {}) }
    snapshot("menu", size: CGSize(width: 372, height: 520)) { MenuPanel(model: model, openPR: { _ in }, openInbox: {}, openSettings: {}) }
    snapshot("firstrun", size: CGSize(width: 780, height: 860)) { FirstRunView(model: model, onContinue: {}) }
    let prKey = PrKey(owner: "acme", repo: "web", number: 4127)
    let prDiff: PrDiffMessage = decode(#"""
    {"requestId":"d","pr":{"owner":"acme","repo":"web","number":4127},"baseSha":"9c41f07e1d2c3b4a59687f6e5d4c3b2a19081726","headSha":"\#(sha)","files":[
     {"path":"src/map/clusterPins.ts","status":"modified","additions":188,"deletions":12,"binary":false,"truncated":false,"patch":"@@ -38,6 +38,9 @@ export function clusterPins(\n   pins: Pin[],\n   zoom: number,\n ): Cluster[] {\n-  if (zoom > 12) return pins.map(toSingle);\n+  if (zoom >= CLUSTER_MAX_ZOOM) {\n+    return pins.map(toSingle);\n+  }\n   const grid = new Map<string, Pin[]>();\n"},
     {"path":"src/api/tripPins.ts","status":"modified","additions":46,"deletions":30,"binary":false,"truncated":false,"patch":"@@ -12,3 +12,3 @@\n export async function fetchTripPins(\n-  opts?: { limit?: number },\n+  opts?: { limit?: number; zoom?: number },\n"},
     {"path":"src/map/clusterPins.test.ts","status":"added","additions":96,"deletions":0,"binary":false,"truncated":false,"patch":"@@ -0,0 +1,2 @@\n+import { clusterPins } from './clusterPins';\n+test('clusters', () => {});\n"},
     {"path":"yarn.lock","status":"modified","additions":33,"deletions":19,"binary":false,"truncated":false},
     {"path":"fixtures/trips/round-the-world.json","status":"added","additions":2410,"deletions":0,"binary":false,"truncated":true}]}
    """#)
    let prLabels: RiskLabelsMessage = decode(#"""
    {"requestId":"l","pr":{"owner":"acme","repo":"web","number":4127},"headSha":"\#(sha)","status":"ready","agent":"cursor","model":"auto","files":[
     {"path":"src/map/clusterPins.ts","risk":"high","reason":"Clustering now runs on every pan; can block the main thread on long trips","rank":0,"source":"agent"},
     {"path":"src/api/tripPins.ts","risk":"medium","reason":"Changes the request shape for /trips/:id/pins","rank":1,"source":"agent"},
     {"path":"src/map/clusterPins.test.ts","risk":"low","reason":"Tests only","rank":2,"source":"agent"},
     {"path":"yarn.lock","risk":"low","reason":"Lockfile","rank":3,"source":"rule"},
     {"path":"fixtures/trips/round-the-world.json","risk":"unlabeled","reason":"Too big to label. Review by hand","rank":4,"source":"rule"}]}
    """#)
    let prReview: ReviewState = decode(#"{"startedAt":"\#(iso(hoursAgo: 1))","headSha":"\#(sha)","latestHeadSha":"\#(sha)","worktreePath":"/tmp/wt","phase":"ready","labels":"ready"}"#)
    let turn = ChatTurn(question: "What could break for trips that cross the date line?", answer: "Pins near ±180° land in different cells, so one stop can show up as **two clusters**.\n\n`cellKey` floors lng without wrapping it (clusterPins.ts:79). No test covers it.", agent: .cursor, model: "auto", headSha: sha)
    let prStore = PRStore(preview: prKey, model: model, review: prReview, labels: prLabels, diff: prDiff, turns: [turn])
    let runningLabels: RiskLabelsMessage = decode(#"{"requestId":"l","pr":{"owner":"acme","repo":"web","number":4127},"headSha":"\#(sha)","status":"running","agent":"cursor","model":"","files":[],"progress":{"startedAt":"\#(iso(hoursAgo: 0.0117))","agentFiles":4,"activity":["Read File src/map/clusterPins.ts","Searched repo for cellKey","Read File src/map/clusterPins.test.ts"]}}"#)
    let labeling = PRStore(preview: prKey, model: model, review: prReview, labels: runningLabels, diff: prDiff)
    snapshot("pr-sidebar-labeling", size: CGSize(width: 320, height: 520)) { NavigationStack { RankedFilesSidebar(store: labeling, model: model) } }
    let cachedStore = PRStore(preview: prKey, model: model, review: nil, labels: prLabels, diff: prDiff)
    snapshot("pr-sidebar-cached", size: CGSize(width: 320, height: 760)) { NavigationStack { RankedFilesSidebar(store: cachedStore, model: model) } }
    snapshot("pr-sidebar", size: CGSize(width: 320, height: 640)) { NavigationStack { RankedFilesSidebar(store: prStore, model: model) } }
    let longPatch = "@@ -0,0 +1,300 @@\\n" + (1...300).map { "+const line\($0) = \($0);" }.joined(separator: "\\n") + "\\n"
    let longDiff: PrDiffMessage = decode(#"{"requestId":"d","pr":{"owner":"acme","repo":"web","number":4127},"baseSha":"b","headSha":"\#(sha)","files":[{"path":"src/long.ts","status":"added","additions":300,"deletions":0,"binary":false,"truncated":false,"patch":"\#(longPatch)"}]}"#)
    let restored = PRStore(preview: prKey, model: model, review: prReview, labels: nil, diff: longDiff, turns: [turn])
    restored.diffScroll = (sha, 420)
    snapshot("pr-tab-restored", size: CGSize(width: 1200, height: 700)) { NavigationStack { PRTabView(model: model, workspace: ws, store: restored) } }
    snapshot("pr-tab", size: CGSize(width: 1200, height: 700)) { NavigationStack { PRTabView(model: model, workspace: ws, store: prStore) } }
    snapshot("chat", size: CGSize(width: 360, height: 640)) { ChatInspector(store: prStore, model: model, focusComposer: .constant(false)) }
    snapshot("settings", size: CGSize(width: 640, height: 720)) { SettingsView(model: model, prefs: prefs) }
    snapshot("menubar-label", size: CGSize(width: 80, height: 24)) { MenuBarLabel(model: model, showCount: true) }
}
