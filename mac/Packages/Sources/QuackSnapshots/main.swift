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
    item(4131, "web", "Bump vite to 6.2", "bram-dewit", role: "reviewer", adds: 12, dels: 12, ci: "passing", hours: 226 * 24 + 5, review: "stale"),
    item(4100, "web", "Archive old trips in bulk", "bram-dewit", role: "reviewer", adds: 40, dels: 2, ci: "passing", hours: 170 * 24 + 22),
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

/// Self-check: line selection in the diff survives label updates. Labels change while labeling runs
/// (and used to rebuild every row), so this selects lines, opens the ask card, types, pushes new labels,
/// and checks the selection, the card, its text and its focus are all still there.
/// A JavaScript string literal (JSON-escaped).
func jsString(_ s: String) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: s, options: .fragmentsAllowed), encoding: .utf8)!
}

@MainActor
func selectionSelfCheck(_ view: some View, labels: String) {
    let size = CGSize(width: 1200, height: 700)
    let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
    let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    window.contentView = host
    window.setFrameOrigin(CGPoint(x: -10_000, y: -10_000))
    window.makeKeyAndOrderFront(nil)
    RunLoop.main.run(until: Date().addingTimeInterval(3))
    guard let web = findWebView(host) else { print("FAIL: no web view"); exit(1) }
    func js(_ code: String) -> String {
        var out = "?"
        var done = false
        web.evaluateJavaScript(code) { r, e in out = r.map { "\($0)" } ?? "error: \(e.map { "\($0)" } ?? "nil")"; done = true }
        while !done { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        return out
    }
    let result = js("""
    (() => {
      const gutters = () => [...document.querySelectorAll('[data-g]')].filter(e => e.closest('[data-i]') && !e.dataset.plus);
      const g = gutters();
      const a = g[2].getBoundingClientRect(), b = g[6].getBoundingClientRect();
      const opts = (r) => ({ bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width/2, clientY: r.y + r.height/2 });
      g[2].dispatchEvent(new MouseEvent('mousedown', opts(a)));
      window.dispatchEvent(new MouseEvent('mousemove', opts(b)));
      const midDrag = document.querySelectorAll('.pick').length;
      window.quack.render(JSON.parse(\(jsString(labels))));
      window.dispatchEvent(new MouseEvent('mouseup', opts(b)));
      const picked = document.querySelectorAll('.pick').length;
      // The Ask button shows once the drag ends, and survives the next label update.
      const askButton = document.querySelector('.askpill button');
      window.quack.render(JSON.parse(\(jsString(labels.replacingOccurrences(of: "New module", with: "Changed module")))));
      const buttonKept = !!askButton && askButton.isConnected;

      askButton && askButton.click();
      const ta = document.getElementById('ask-text');
      if (!ta) return JSON.stringify({ midDrag, buttonKept, picked, card: false });
      ta.value = 'why?';
      window.quack.render(JSON.parse(\(jsString(labels.replacingOccurrences(of: "\"high\"", with: "\"low\"")))));
      const ta2 = document.getElementById('ask-text');
      return JSON.stringify({ midDrag, buttonKept, picked, card: !!ta2 && ta2.isConnected, text: ta2 && ta2.value, focused: document.activeElement === ta2,
        badge: !!document.querySelector('.fh') });
    })()
    """)
    print("selection across label updates:", result)
    // The hover "+": a click on it selects that one line and opens the ask card straight away.
    let plus = js("""
    (() => {
      document.querySelector('#card .x, #card [data-close]')?.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const p = [...document.querySelectorAll('.plus')][9];
      if (!p) return 'no plus';
      const r = p.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
      p.dispatchEvent(new MouseEvent('mousedown', o));
      window.dispatchEvent(new MouseEvent('mouseup', o));
      return JSON.stringify({ card: !!document.getElementById('ask-text'), count: document.getElementById('pill-count')?.textContent, focused: document.activeElement?.id });
    })()
    """)
    print("plus click:", plus)
    // A picture with the "+" forced visible on one line, for the eye.
    _ = js("document.querySelector('#card') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); const s = document.createElement('style'); s.textContent = '.row:nth-child(14) .plus{opacity:1}'; document.head.append(s); 'ok'")
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    var shot: NSImage?
    web.takeSnapshot(with: nil) { image, _ in shot = image }
    while shot == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    if let dir = CommandLine.arguments.dropFirst().first, let tiff = shot?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("diff-plus.png"))
    }
    window.orderOut(nil)
    let ok = result.contains("\"buttonKept\":true") && result.contains("\"card\":true") && result.contains("\"text\":\"why?\"") && result.contains("\"focused\":true") && !result.contains("\"picked\":0") && plus.contains("\"card\":true") && plus.contains("1 line selected") && plus.contains("\"focused\":\"ask-text\"")
    print(ok ? "PASS" : "FAIL")
    exit(ok ? 0 : 1)
}

@MainActor
func writeBoards(inbox: InboxMessage, prKey: PrKey, prReview: ReviewState, prLabels: RiskLabelsMessage, prDiff: PrDiffMessage, ws: Workspace) {
    // Writing reviews: viewed ticks, the since-last-review banner, a failed write.
    let writeHello: HelloResponse = decode(#"{"requestId":"h","version":"0.3.0","protocol":3,"viewer":"dev","capabilities":{"workspace":true,"inbox":true,"labels":true,"review":true,"agents":["cursor"],"write":true}}"#)
    let writeModel = AppModel(preview: inbox, connection: .connected(writeHello), checks: checks, settings: settings, agents: agents)
    let lastRev: LastReview = decode(#"{"commit":"5d2e8b1c0a9f4e7d6c3b2a1908f7e6d5c4b3a291","submittedAt":"\#(iso(hoursAgo: 49))","state":"COMMENTED"}"#)
    let viewedStates: [String: ViewedState] = [
        "src/map/clusterPins.test.ts": .viewed, "yarn.lock": .viewed, "src/api/tripPins.ts": .dismissed,
    ]
    let writeStore = PRStore(preview: prKey, model: writeModel, review: prReview, labels: prLabels, diff: prDiff)
    writeStore.previewReview(viewed: viewedStates, lastReview: lastRev, viewer: "dev")
    snapshot("pr-sidebar-viewed", size: CGSize(width: 320, height: 640)) { NavigationStack { RankedFilesSidebar(store: writeStore, model: writeModel) } }
    let sinceDiff: PrDiffMessage = decode(#"""
    {"requestId":"d","pr":{"owner":"acme","repo":"web","number":4127},"baseSha":"5d2e8b1c0a9f4e7d6c3b2a1908f7e6d5c4b3a291","headSha":"\#(sha)","since":{"sha":"5d2e8b1c0a9f4e7d6c3b2a1908f7e6d5c4b3a291","commits":3},"files":[
     {"path":"src/map/clusterPins.ts","status":"modified","additions":21,"deletions":4,"binary":false,"truncated":false},
     {"path":"src/api/tripPins.ts","status":"modified","additions":6,"deletions":2,"binary":false,"truncated":false},
     {"path":"src/map/clusterPins.test.ts","status":"modified","additions":12,"deletions":0,"binary":false,"truncated":false}]}
    """#)
    let sinceStore = PRStore(preview: prKey, model: writeModel, review: prReview, labels: prLabels, diff: sinceDiff)
    sinceStore.previewReview(viewed: viewedStates, lastReview: lastRev, viewer: "dev")
    sinceStore.writeError = ServerError(code: .badRequest, message: "GitHub said the token can’t review this repo.", fixSteps: [FixStep(text: "Refresh your GitHub login.", command: "gh auth refresh -h github.com -s repo")])
    snapshot("pr-sidebar-since", size: CGSize(width: 320, height: 420)) { NavigationStack { RankedFilesSidebar(store: sinceStore, model: writeModel) } }
    snapshot("pr-tab-since", size: CGSize(width: 1200, height: 700)) { NavigationStack { PRTabView(model: writeModel, workspace: ws, store: sinceStore) } }

    // Submit review sheet: the gap check section.
    func gapMessage(_ findings: String) -> GapCheckMessage {
        decode(#"{"requestId":"g","pr":{"owner":"acme","repo":"web","number":4127},"headSha":"\#(sha)","agent":"cursor","model":"auto","ms":48000,"findings":[\#(findings)],"checkedFiles":6,"skipped":[{"path":"yarn.lock","reason":"lock file"},{"path":"src/gen/schema.ts","reason":"generated"}]}"#)
    }
    let gapFindings = gapMessage(#"""
    {"id":"g1","path":"src/map/clusterPins.ts","line":42,"body":"clusterPins returns early when the list is empty, but the caller in TripMap still reads the first cluster. That throws for a trip with no pins."},
    {"id":"g2","path":"src/api/tripPins.ts","line":18,"body":"There is no test for a trip whose pins all share one coordinate. They collapse into a single cluster of zero width."}
    """#)
    let gapStore = PRStore(preview: prKey, model: writeModel, review: prReview, labels: prLabels, diff: prDiff)
    func gapBoard(_ name: String, _ height: CGFloat, _ state: GapCheckState?, kept: [String: String] = [:]) {
        snapshot(name, size: CGSize(width: 620, height: height)) { GapCheckView(store: gapStore, previewState: state, previewKept: kept).padding(10) }
    }
    gapBoard("gap-idle", 110, .idle)
    gapBoard("gap-running", 90, .running(started: Date().addingTimeInterval(-74), activity: ["Reading src/map/clusterPins.ts", "Searching for callers of clusterPins"]))
    gapBoard("gap-done", 420, .done(gapFindings), kept: ["g2": "d1"])
    gapBoard("gap-done-empty", 100, .done(gapMessage("")))
    gapBoard("gap-failed", 80, .failed(ServerError(code: .agentFailed, message: "Cursor stopped after 90 seconds without an answer.")))

    // Submit review sheet, sent toast, failed panel.
    func draftJSON(_ id: String, _ path: String, _ line: Int, _ start: Int?, _ body: String, _ origin: String) -> String {
        #"{"id":"\#(id)","headSha":"\#(sha)","anchor":{"path":"\#(path)","side":"RIGHT","line":\#(line)\#(start.map { #","startLine":\#($0)"# } ?? "")},"body":"\#(body)","origin":"\#(origin)","createdAt":"\#(iso(hoursAgo: 1))","updatedAt":"\#(iso(hoursAgo: 1))"}"#
    }
    let submitDrafts: [DraftComment] = decode("[" + [
        draftJSON("s1", "src/map/clusterPins.ts", 42, 38, "This returns early on an empty list, but TripMap still reads the first cluster. Guard the caller too.", "me"),
        draftJSON("s2", "src/api/tripPins.ts", 18, nil, "No test covers a trip whose pins share one coordinate. They collapse into a zero-width cluster.", "gap_check"),
        draftJSON("s3", "src/map/clusterPins.test.ts", 12, nil, "Nit: name this case after the behaviour, not the input.", "me"),
    ].joined(separator: ",") + "]")
    let submitStore = PRStore(preview: prKey, model: writeModel, review: prReview, labels: prLabels, diff: prDiff)
    submitStore.previewReview(drafts: submitDrafts, viewed: viewedStates, viewer: "dev")
    submitStore.previewSubmit(.idle, summary: "Clustering looks right overall. The empty-list path needs a guard before this can merge.", event: .requestChanges)
    snapshot("submit-sheet", size: CGSize(width: 640, height: 760)) { SubmitReviewSheet(store: submitStore) }
    let sentMessage: ReviewSubmittedMessage = decode(#"{"requestId":"r","pr":{"owner":"acme","repo":"web","number":4127},"event":"REQUEST_CHANGES","url":"https://github.com/acme/web/pull/4127#pullrequestreview-1","comments":3,"replies":1}"#)
    snapshot("submit-sent", size: CGSize(width: 700, height: 100)) { SubmitSentToast(store: submitStore, message: sentMessage).padding(20) }
    let deniedError = ServerError(code: .ghWriteDenied, message: "Resource not accessible by personal access token.", fixSteps: [FixStep(text: "Give the gh login permission to write to repos.", command: "gh auth refresh --hostname github.com --scopes repo")])
    snapshot("submit-failed", size: CGSize(width: 640, height: 260)) {
        SubmitFailedPanel(store: submitStore, error: deniedError, event: .requestChanges, summary: submitStore.reviewSummary).padding(20)
    }
}

/// Self-check for writing reviews in the diff: threads and pending comments render under their lines,
/// the selection bar offers Comment, C opens the editor, a failed save keeps the text, a new thread
/// arriving mid-typing keeps the focus, and a successful save closes the editor. Writes a picture too.
@MainActor
func reviewSelfCheck(_ view: some View, out: String?) {
    let size = CGSize(width: 1200, height: 760)
    let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
    let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    window.contentView = host
    window.setFrameOrigin(CGPoint(x: -10_000, y: -10_000))
    window.makeKeyAndOrderFront(nil)
    RunLoop.main.run(until: Date().addingTimeInterval(3))
    guard let web = findWebView(host) else { print("FAIL: no web view"); exit(1) }
    func js(_ code: String) -> String {
        var result = "?"
        var done = false
        web.evaluateJavaScript(code) { r, e in result = r.map { "\($0)" } ?? "error: \(e.map { "\($0)" } ?? "nil")"; done = true }
        while !done { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        return result
    }
    let shown = js("""
    JSON.stringify({ threads: document.querySelectorAll('.thread[data-thread]').length,
      resolved: document.querySelectorAll('.thread.resolved').length,
      drafts: [...document.querySelectorAll('.ptag')].length,
      dots: document.querySelectorAll('.cdot').length,
      viewed: document.querySelectorAll('.fh .viewed').length,
      text: (document.querySelector('.thread[data-thread] .cbody') || {}).textContent })
    """)
    print("review rows:", shown)
    func picture(_ name: String) {
        guard let out else { return }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        var shot: NSImage?
        web.takeSnapshot(with: nil) { image, _ in shot = image }
        while shot == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        if let tiff = shot?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: out).appendingPathComponent("\(name).png"))
        }
    }
    // The selection bar on lines 9–11, with the threads and the pending comment around it.
    _ = js("(() => { const byLine = (n) => [...document.querySelectorAll('.dl')].find(d => d.children[1] && d.children[1].textContent === String(n)).children[1]; const s = byLine(9), e = byLine(11); const o = (el) => { const r = el.getBoundingClientRect(); return { bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width/2, clientY: r.y + r.height/2 }; }; const ob = o(e); s.dispatchEvent(new MouseEvent('mousedown', o(s))); const afterDown = document.querySelectorAll('.pick').length; const hit = document.elementFromPoint(ob.clientX, ob.clientY); window.dispatchEvent(new MouseEvent('mousemove', ob)); const afterMove = document.querySelectorAll('.pick').length; window.dispatchEvent(new MouseEvent('mouseup', ob)); return JSON.stringify({ afterDown, afterMove, end: document.querySelectorAll('.pick').length, hit: hit && hit.className, y: ob.clientY }); })()")
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    picture("diff-review-threads")
    _ = js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'")
    let flow = js("""
    (() => {
      const byLine = (n) => [...document.querySelectorAll('.dl')].find(d => d.children[1] && d.children[1].textContent === String(n)).children[1];
      const start = byLine(9), end = byLine(11);
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect();
      const o = (r) => ({ bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width/2, clientY: r.y + r.height/2 });
      start.dispatchEvent(new MouseEvent('mousedown', o(a)));
      window.dispatchEvent(new MouseEvent('mousemove', o(b)));
      window.dispatchEvent(new MouseEvent('mouseup', o(b)));
      const bar = document.querySelector('.actbar');
      const barText = bar ? bar.textContent : null;
      document.getElementById('scroller').dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      const ta = document.getElementById('ed-text');
      if (!ta) return JSON.stringify({ barText, editor: false });
      ta.value = 'Why a magic number here?';
      ta.dispatchEvent(new Event('input'));
      window.quack.draftSaved(false);
      const keptAfterFailure = !!document.getElementById('ed-text') && document.getElementById('ed-text').value;
      return JSON.stringify({ barText, editor: true, where: document.getElementById('ed-where').textContent, focused: document.activeElement === ta, keptAfterFailure });
    })()
    """)
    print("comment flow:", flow)
    // A thread arrives (another poll) while typing: the editor keeps its text and focus.
    let pushed = js("""
    (() => {
      const before = document.getElementById('ed-text');
      before.setSelectionRange(3, 3);
      window.quack.setReview({ enabled: true, me: { initials: 'DE', color: '#2563eb' }, drafts: [], viewed: {}, threads: [{ id: 'PRRT_new', path: 'src/long.ts', side: 'RIGHT', line: 40, startLine: null, isResolved: false, isOutdated: false, canResolve: true, canReply: true, comments: [{ author: 'pat-author', initials: 'PA', color: '#7a5af8', when: 'just now', body: 'Pushed a fix' }] }] });
      const ta = document.getElementById('ed-text');
      return JSON.stringify({ same: ta === before, focused: document.activeElement === ta, caret: ta.selectionStart, text: ta.value, threads: document.querySelectorAll('.thread[data-thread]').length });
    })()
    """)
    print("thread arrives while typing:", pushed)
    picture("diff-review-editor")
    let saved = js("window.quack.draftSaved(true); JSON.stringify({ editor: !!document.getElementById('ed-text') && document.getElementById('ed-text').isConnected })")
    print("after a successful save:", saved)
    // "Turn into comment": the agent's draft opens on its lines; Redraft disables it, then fills new text.
    let agent = js("""
    (() => {
      window.quack.openDraftEditor({ anchor: { path: 'src/long.ts', side: 'RIGHT', line: 30, startLine: 28 }, body: 'Could `line30` be a constant?' });
      const ta = document.getElementById('ed-text');
      const opened = { text: ta && ta.value, where: document.getElementById('ed-where').textContent, tag: !document.getElementById('ed-tag').hidden,
        redraft: !document.getElementById('ed-redraft').hidden, cancel: document.getElementById('ed-cancel').textContent, focused: document.activeElement === ta };
      window.quack.openDraftEditor({ anchor: { path: 'src/long.ts', side: 'RIGHT', line: 30, startLine: 28 }, body: '', redrafting: true });
      const busy = { disabled: ta.disabled, label: document.getElementById('ed-redraft').textContent };
      window.quack.openDraftEditor({ anchor: { path: 'src/long.ts', side: 'RIGHT', line: 30, startLine: 28 }, body: 'Why is `line30` 30?' });
      return JSON.stringify({ opened, busy, after: { text: ta.value, disabled: ta.disabled, editors: document.querySelectorAll('#ed-text').length } });
    })()
    """)
    print("turn into comment:", agent)
    picture("diff-review-agent")
    // Split view: the bar sits under the side the lines were selected on.
    let split = js("""
    (() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.quack.setLayout('split');
      const gut = (n) => [...document.querySelectorAll('.half[data-side=new] .g')].find(g => g.textContent === String(n));
      gut(9).scrollIntoView({ block: 'center' });
      const s = gut(9), e = gut(11);
      const o = (el) => { const r = el.getBoundingClientRect(); return { bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width/2, clientY: r.y + r.height/2 }; };
      const oe = o(e);
      s.dispatchEvent(new MouseEvent('mousedown', o(s)));
      window.dispatchEvent(new MouseEvent('mousemove', oe));
      window.dispatchEvent(new MouseEvent('mouseup', oe));
      const bar = document.querySelector('.actbar'), half = s.closest('.half');
      return JSON.stringify({ bar: !!bar, onNewSide: !!bar && bar.getBoundingClientRect().left >= half.getBoundingClientRect().left, label: bar && bar.querySelector('.lbl').textContent });
    })()
    """)
    print("split view bar:", split)
    // The comment editor opens under the right side too.
    let splitEditor = js("""
    (() => {
      document.getElementById('scroller').dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      const ta = document.getElementById('ed-text');
      const half = document.querySelector('.half[data-side=new]');
      return JSON.stringify({ editor: !!ta, right: !!ta && ta.closest('.thread').getBoundingClientRect().left >= half.getBoundingClientRect().left, rowRs: !!ta && ta.closest('.row').classList.contains('rs') });
    })()
    """)
    print("split view editor:", splitEditor)
    picture("diff-review-split")
    // A pending comment whose lines changed in a newer commit: flagged, with Move and Delete.
    let outdatedShown = js("""
    (() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.quack.setLayout('unified');
      window.quack.setReview({ enabled: true, me: { initials: 'DE', color: '#2563eb' }, threads: [], viewed: {}, drafts: [{ id: 'd-old', path: 'src/long.ts', side: 'RIGHT', line: 12, startLine: null, replyTo: null, body: 'Why 12?', origin: 'me', outdated: { old: ['const line12 = 12;'], now: ['const line12 = 120;'], changedIn: 'c3d8e11' } }] });
      const t = [...document.querySelectorAll('.otag')].find(x => x.textContent === 'Outdated');
      const box = t && t.closest('.thread');
      return JSON.stringify({ flagged: !!t, note: box && box.querySelector('.tc.outdated .l3').textContent, move: !!box && [...box.querySelectorAll('button')].some(b => b.textContent === 'Move to new line' && !b.disabled), lines: box && box.querySelectorAll('.ol').length });
    })()
    """)
    print("outdated comment:", outdatedShown)
    picture("diff-review-outdated")
    window.orderOut(nil)
    let ok = shown.contains("\"threads\":2") && shown.contains("\"resolved\":1") && shown.contains("\"drafts\":1") && !shown.contains("\"dots\":0")
        && !shown.contains("\"viewed\":0") && flow.contains("Comment") && flow.contains("\"focused\":true") && flow.contains("magic number")
        && flow.contains("lines 9–11") && pushed.contains("\"same\":true") && pushed.contains("\"focused\":true") && pushed.contains("\"caret\":3")
        && saved.contains("\"editor\":false") && agent.contains("\"where\":\"on lines 28–30\"") && agent.contains("\"tag\":true")
        && agent.contains("\"cancel\":\"Discard\"") && agent.contains("\"disabled\":true,\"label\":\"Redrafting…\"")
        && agent.contains("\"text\":\"Why is `line30` 30?\",\"disabled\":false,\"editors\":1") && split.contains("\"onNewSide\":true,\"label\":\"Lines 9–11\"") && splitEditor.contains("\"right\":true,\"rowRs\":true") && outdatedShown.contains("\"flagged\":true,\"note\":\"line 12 changed in c3d8e11\",\"move\":true,\"lines\":2")
    print(ok ? "PASS" : "FAIL")
    exit(ok ? 0 : 1)
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
    let deepFiles: [(String, String, String, Int, Int)] = [
        ("src/travel-book/map/TravelBookMapInner.tsx", "high", "Core map, route and readiness orchestration; no unit tests", 152, 0),
        ("src/utils/use-add-poster-route-to-map.ts", "high", "Shared poster hook; new fallback path lightly tested", 12, 3),
        ("src/travel-book/map/TravelBookStepMarkers.tsx", "medium", "Marker readiness gating can block the printer", 119, 0),
        ("src/travel-book/map/flights/TravelBookStepMarkers.tsx", "medium", "Same name, different folder: flight markers", 65, 0),
        ("src/travel-book/map/utils/get-trip-flight-segment-buckets.ts", "medium", "Complex flight bucketing can throw; covered by tests", 87, 0),
        ("package.json", "low", "Version bump", 1, 1),
    ]
    let deepDiff: PrDiffMessage = decode(#"{"requestId":"d","pr":{"owner":"acme","repo":"web","number":4127},"baseSha":"b","headSha":"\#(sha)","files":[\#(deepFiles.map { #"{"path":"\#($0.0)","status":"modified","additions":\#($0.3),"deletions":\#($0.4),"binary":false,"truncated":false}"# }.joined(separator: ","))]}"#)
    let deepLabels: RiskLabelsMessage = decode(#"{"requestId":"l","pr":{"owner":"acme","repo":"web","number":4127},"headSha":"\#(sha)","status":"ready","agent":"cursor","model":"auto","files":[\#(deepFiles.enumerated().map { #"{"path":"\#($1.0)","risk":"\#($1.1)","reason":"\#($1.2)","rank":\#($0),"source":"agent"}"# }.joined(separator: ","))]}"#)
    let deepStore = PRStore(preview: prKey, model: model, review: prReview, labels: deepLabels, diff: deepDiff)
    snapshot("pr-sidebar-deep", size: CGSize(width: 320, height: 640)) { NavigationStack { RankedFilesSidebar(store: deepStore, model: model) } }
    if ProcessInfo.processInfo.environment["QUACK_REVIEW_CHECK"] != nil {
        let writeHello: HelloResponse = decode(#"{"requestId":"h","version":"0.3.0","protocol":3,"viewer":"dev","capabilities":{"workspace":true,"inbox":true,"labels":true,"review":true,"agents":["cursor"],"write":true}}"#)
        let writeModel = AppModel(preview: inbox, connection: .connected(writeHello), checks: checks, settings: settings, agents: agents)
        let longPatch = "@@ -0,0 +1,60 @@\\n" + (1...60).map { "+const line\($0) = \($0);" }.joined(separator: "\\n") + "\\n"
        let diff: PrDiffMessage = decode(#"{"requestId":"d","pr":{"owner":"acme","repo":"web","number":4127},"baseSha":"b","headSha":"\#(sha)","files":[{"path":"src/long.ts","status":"added","additions":60,"deletions":0,"binary":false,"truncated":false,"patch":"\#(longPatch)"}]}"#)
        let store = PRStore(preview: prKey, model: writeModel, review: prReview, labels: nil, diff: diff)
        let threads: [ReviewThread] = decode(#"[{"id":"PRRT_1","path":"src/long.ts","side":"RIGHT","line":4,"startLine":null,"originalLine":4,"isResolved":false,"isOutdated":false,"canResolve":true,"canReply":true,"comments":[{"id":"c1","author":"pat-author","body":"Should `line4` be a constant?","createdAt":"\#(iso(hoursAgo: 30))","url":"u"},{"id":"c2","author":"dev","body":"Yes, will do.","createdAt":"\#(iso(hoursAgo: 20))","url":"u"}]},{"id":"PRRT_2","path":"src/long.ts","side":"RIGHT","line":30,"startLine":null,"originalLine":30,"isResolved":true,"isOutdated":false,"canResolve":true,"canReply":true,"comments":[{"id":"c3","author":"sam-other","body":"Can this throw?","createdAt":"\#(iso(hoursAgo: 50))","url":"u"}]}]"#)
        let drafts: [DraftComment] = decode(#"[{"id":"0b9f3c1e-0000-4000-8000-000000000001","headSha":"\#(sha)","anchor":{"path":"src/long.ts","side":"RIGHT","line":22,"startLine":20},"body":"Where does `22` come from?","origin":"me","createdAt":"\#(iso(hoursAgo: 1))","updatedAt":"\#(iso(hoursAgo: 1))"}]"#)
        store.previewReview(drafts: drafts, threads: threads, viewed: ["src/long.ts": .viewed], viewer: "dev")
        reviewSelfCheck(NavigationStack { PRTabView(model: writeModel, workspace: ws, store: store) }, out: CommandLine.arguments.dropFirst().first)
    }
    if ProcessInfo.processInfo.environment["QUACK_SELECT_CHECK"] != nil {
        let longPatch = "@@ -0,0 +1,60 @@\\n" + (1...60).map { "+const line\($0) = \($0);" }.joined(separator: "\\n") + "\\n"
        let diff: PrDiffMessage = decode(#"{"requestId":"d","pr":{"owner":"acme","repo":"web","number":4127},"baseSha":"b","headSha":"\#(sha)","files":[{"path":"src/long.ts","status":"added","additions":60,"deletions":0,"binary":false,"truncated":false,"patch":"\#(longPatch)"}]}"#)
        let store = PRStore(preview: prKey, model: model, review: prReview, labels: nil, diff: diff)
        let filesJSON = String(data: try! JSONEncoder().encode(diff.files), encoding: .utf8)!
        let labels = #"{"files":\#(filesJSON),"layout":"unified","headSha":"\#(sha)","labels":{"src/long.ts":{"path":"src/long.ts","risk":"high","reason":"New module","rank":0,"source":"agent"}}}"#
        selectionSelfCheck(NavigationStack { PRTabView(model: model, workspace: ws, store: store) }, labels: labels)
    }
    writeBoards(inbox: inbox, prKey: prKey, prReview: prReview, prLabels: prLabels, prDiff: prDiff, ws: ws)
    assignBoards()
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
