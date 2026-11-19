import AppKit
import QuackProtocol
import QuackStores
import SwiftUI
import WebKit

public enum DiffLayout: String, Sendable {
    case unified
    case split
}

/// Menu and shortcut hooks for the diff: forwards to the web view once it is attached.
@MainActor
public final class DiffController {
    fileprivate weak var webView: WKWebView?
    public private(set) var fontSize: Double = 12

    public init() {}

    public func nextHunk() { call("nextHunk()") }
    public func previousHunk() { call("previousHunk()") }
    public func nextFile() { call("nextFile()") }
    public func previousFile() { call("previousFile()") }
    public func scrollTo(path: String) { call("scrollToFile(\(jsLiteral(path)))") }
    public func scrollTo(top: Double) { call("scrollToTop(\(top))") }

    public func setFontSize(_ size: Double) {
        fontSize = min(max(size, 9), 24)
        call("setFontSize(\(fontSize))")
    }

    fileprivate func call(_ expression: String) {
        webView?.evaluateJavaScript("window.quack && window.quack.\(expression)", completionHandler: nil)
    }
}

/// The diff: one WKWebView (see mac/renderer) plus native loading, error and empty states.
public struct DiffView: View {
    var store: PRStore
    var layout: DiffLayout
    var controller: DiffController
    var onAsk: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    public init(store: PRStore, layout: DiffLayout, controller: DiffController, onAsk: @escaping () -> Void) {
        self.store = store
        self.layout = layout
        self.controller = controller
        self.onAsk = onAsk
    }

    public var body: some View {
        if let diff = store.diff, !diff.files.isEmpty {
            DiffWebView(
                store: store, diff: diff, labels: store.visibleLabels, layout: layout, scheme: colorScheme,
                selectedFile: store.selectedFile, controller: controller, onAsk: onAsk
            )
        } else if store.diff != nil {
            EmptyState(symbol: "doc.text", headline: "No changes to show.", message: "This pull request has no file changes.")
        } else if let error = store.diffError, !store.loadingDiff {
            EmptyState(symbol: "exclamationmark.triangle", headline: "Couldn't load the diff.", message: error.message) {
                Button("Retry") { Task { await store.loadDiff() } }
            }
        } else {
            DiffSkeleton()
        }
    }
}

// MARK: - Loading skeleton

private struct DiffSkeleton: View {
    private let widths: [CGFloat?] = [180, 260, 120, 320, 90, 220, 160, 280, 140, 200, 110, 240, 170, 130, 300, 100]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                SkeletonBar(width: 220)
                SkeletonBar(width: 44)
                Spacer()
                SkeletonBar(width: 70)
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(widths.enumerated()), id: \.offset) { _, w in
                    HStack(spacing: 14) {
                        SkeletonBar(width: 28)
                        SkeletonBar(width: w)
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 14)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading the diff")
    }
}

// MARK: - Web view

private struct DiffWebView: NSViewRepresentable {
    var store: PRStore
    var diff: PrDiffMessage
    var labels: RiskLabelsMessage?
    var layout: DiffLayout
    var scheme: ColorScheme
    var selectedFile: String?
    var controller: DiffController
    var onAsk: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        let config = WKWebViewConfiguration()
        config.userContentController.add(coordinator, name: "quack")
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = coordinator
        web.allowsBackForwardNavigationGestures = false
        coordinator.webView = web
        coordinator.parent = self
        controller.webView = web
        coordinator.start()
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        controller.webView = web
        context.coordinator.sync()
    }

    static func dismantleNSView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "quack")
        web.stopLoading()
    }

    // MARK: Coordinator

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: DiffWebView!
        weak var webView: WKWebView?
        private var ready = false
        private var sentDiffKey: String?
        private var sentLabels: RiskLabelsMessage??
        private var sentLayout: DiffLayout?
        private var sentScheme: ColorScheme?
        private var filesJSON = "[]"
        /// The file the web view itself reported; selecting it from the sidebar must not scroll again.
        private var reportedByWeb: String?
        private var lastScrolled: String?
        /// The saved position is restored once, after the first render following `ready`.
        private var restoredAfterReady = false

        // Loading

        func start() {
            Task { @MainActor [weak self] in
                guard let web = self?.webView else { return }
                if let list = await Self.blockNetworkRules() {
                    web.configuration.userContentController.add(list)
                }
                guard let index = Self.rendererIndex() else { return }
                web.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
            }
        }

        /// Blocks every URL that isn't file:// (the renderer needs no network).
        private static func blockNetworkRules() async -> WKContentRuleList? {
            let rules = """
            [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
             {"trigger":{"url-filter":"^file://"},"action":{"type":"ignore-previous-rules"}}]
            """
            return try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "QuackDiffNoNetwork", encodedContentRuleList: rules)
        }

        private static func rendererIndex() -> URL? {
            let fm = FileManager.default
            var candidates: [URL] = []
            if let resources = Bundle.main.resourceURL { candidates.append(resources.appendingPathComponent("renderer")) }
            var dev = URL(fileURLWithPath: #filePath)
            for _ in 0..<4 { dev.deleteLastPathComponent() }  // QuackUI, Sources, Packages, mac
            candidates.append(dev.appendingPathComponent("renderer/dist"))
            return candidates.map { $0.appendingPathComponent("index.html") }.first { fm.fileExists(atPath: $0.path) }
        }

        // Messages from the page

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                ready = true
                sentDiffKey = nil
                sentLabels = nil
                sentLayout = nil
                sentScheme = nil
                lastScrolled = nil
                restoredAfterReady = false
                parent.controller.setFontSize(parent.controller.fontSize)
                sync()
            case "visibleFile":
                guard let path = body["path"] as? String, path != parent.store.selectedFile else { return }
                reportedByWeb = path
                lastScrolled = path
                parent.store.selectedFile = path
            case "scroll":
                guard let top = (body["top"] as? NSNumber)?.doubleValue, top.isFinite else { return }
                parent.store.diffScroll = (parent.diff.headSha, top)
            case "askInline":
                guard let question = body["question"] as? String, let sel = body["selection"] as? [String: Any],
                      let path = sel["path"] as? String else { return }
                let selection = CodeSelection(
                    path: path, side: (sel["side"] as? String).flatMap(CodeSelection.Side.init(rawValue:)),
                    startLine: (sel["startLine"] as? NSNumber)?.intValue, endLine: (sel["endLine"] as? NSNumber)?.intValue,
                    text: sel["text"] as? String
                )
                parent.store.ask(question, selections: [selection])
                parent.onAsk()
            case "askAboutFile":
                guard let path = body["path"] as? String else { return }
                parent.store.ask("What does this change in \(path), and what could break?", selections: [CodeSelection(path: path)])
                parent.onAsk()
            case "openGitHub":
                NSWorkspace.shared.open(parent.store.pr.githubURL.appendingPathComponent("files"))
            default:
                break  // selectLines: the selection lives in the page until it is asked about.
            }
        }

        // Navigation: only the initial file load; links open in the browser.

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            if navigationAction.navigationType == .other, url.isFileURL { return .allow }
            if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
            return .cancel
        }

        // Pushing state to the page

        func sync() {
            guard ready, let web = webView else { return }
            let p = parent!
            if sentScheme != p.scheme {
                sentScheme = p.scheme
                web.evaluateJavaScript("window.quack.setTheme(\(Self.themeJSON(dark: p.scheme == .dark)))", completionHandler: nil)
            }
            let diffKey = "\(p.diff.requestId)|\(p.diff.headSha)|\(p.diff.files.count)"
            let diffChanged = diffKey != sentDiffKey
            if diffChanged || sentLabels == nil || sentLabels! != p.labels || sentLayout != p.layout {
                if diffChanged { filesJSON = Self.json(p.diff.files) ?? "[]" }
                sentDiffKey = diffKey
                sentLabels = .some(p.labels)
                sentLayout = p.layout
                var byPath: [String: FileRisk] = [:]
                for risk in p.labels?.files ?? [] { byPath[risk.path] = risk }
                let payload = "{\"files\":\(filesJSON),\"labels\":\(Self.json(byPath) ?? "{}"),\"layout\":\"\(p.layout.rawValue)\",\"headSha\":\(jsLiteral(p.diff.headSha))}"
                web.evaluateJavaScript("window.quack.render(\(payload))", completionHandler: nil)
                // The page restores its own scroll position; a sidebar selection made before the first render still applies.
                if diffChanged { lastScrolled = nil }
            }
            if !restoredAfterReady, sentDiffKey != nil {
                restoredAfterReady = true
                if let saved = p.store.diffScroll, saved.headSha == p.diff.headSha {
                    // Wins over the selectedFile scroll; the page then reports the file at this position.
                    p.controller.scrollTo(top: saved.top)
                    lastScrolled = p.selectedFile
                    reportedByWeb = nil
                }
            }
            if let selected = p.selectedFile, selected != lastScrolled {
                lastScrolled = selected
                if selected != reportedByWeb { p.controller.scrollTo(path: selected) }
                reportedByWeb = nil
            }
        }

        private static func json<T: Encodable>(_ value: T) -> String? {
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return String(data: data, encoding: .utf8)
        }

        private static func themeJSON(dark: Bool) -> String {
            let vars = dark ? DiffTheme.dark : DiffTheme.light
            let object = vars.map { "\(jsLiteral($0.key)):\(jsLiteral($0.value))" }.joined(separator: ",")
            return "{\"dark\":\(dark),\"vars\":{\(object)}}"
        }
    }
}

// MARK: - Helpers

private func jsLiteral(_ string: String) -> String {
    guard let data = try? JSONEncoder().encode(string), let text = String(data: data, encoding: .utf8) else { return "\"\"" }
    return text
}

/// The canvas's light and dark variables for the diff (Foundations and PR boards).
private enum DiffTheme {
    static let light: [String: String] = [
        "win": "#ffffff", "pop": "#ffffff", "line": "rgba(0,0,0,.1)", "line2": "rgba(0,0,0,.06)",
        "label": "rgba(0,0,0,.86)", "label2": "rgba(0,0,0,.6)", "label3": "rgba(0,0,0,.45)",
        "fill": "rgba(0,0,0,.05)", "fill2": "rgba(0,0,0,.085)", "glassline": "rgba(0,0,0,.1)",
        "accent": "#007aff", "accent-tint": "rgba(0,122,255,.13)",
        "kw": "#9b2393", "str": "#c41a16", "num": "#1c00cf", "com": "#5d6c79", "type": "#0b4f79", "fn": "#326d74", "code": "#1d1d1f",
        "add-bg": "rgba(52,199,89,.11)", "add-gut": "rgba(52,199,89,.2)", "add-mark": "#1f7a37",
        "del-bg": "rgba(255,59,48,.09)", "del-gut": "rgba(255,59,48,.17)", "del-mark": "#b0281e", "hunk-bg": "rgba(0,122,255,.06)",
        "hi-bg": "#fff1ec", "hi-fg": "#b33928", "hi-line": "#ffcbb9", "md-bg": "#fff4e6", "md-fg": "#915300", "md-line": "#ffddb0",
        "lo-bg": "#f3f5f7", "lo-fg": "#4d5a6e", "lo-line": "#dadfe5", "un-fg": "#56606e", "un-line": "#b9c1cb",
        "pick-bg": "rgba(255,152,15,.13)", "cream": "#fff4e6", "logo-ink": "#1c222e",
        "font": "-apple-system,BlinkMacSystemFont,\"SF Pro Text\",system-ui,sans-serif", "mono": "ui-monospace,\"SF Mono\",Menlo,monospace",
    ]

    static let dark: [String: String] = [
        "win": "#1e1f22", "pop": "#2c2c30", "line": "rgba(255,255,255,.1)", "line2": "rgba(255,255,255,.06)",
        "label": "rgba(255,255,255,.88)", "label2": "rgba(255,255,255,.62)", "label3": "rgba(255,255,255,.44)",
        "fill": "rgba(255,255,255,.07)", "fill2": "rgba(255,255,255,.11)", "glassline": "rgba(255,255,255,.12)",
        "accent": "#0a84ff", "accent-tint": "rgba(10,132,255,.24)",
        "kw": "#fc5fa3", "str": "#fc6a5d", "num": "#d0bf69", "com": "#8a96a2", "type": "#5dd8ff", "fn": "#67b7a4", "code": "#e4e4e6",
        "add-bg": "rgba(48,209,88,.09)", "add-gut": "rgba(48,209,88,.16)", "add-mark": "#5ad37a",
        "del-bg": "rgba(255,69,58,.09)", "del-gut": "rgba(255,69,58,.17)", "del-mark": "#ff7b70", "hunk-bg": "rgba(10,132,255,.1)",
        "hi-bg": "rgba(252,88,63,.16)", "hi-fg": "#ff806c", "hi-line": "rgba(252,88,63,.45)",
        "md-bg": "rgba(255,152,15,.16)", "md-fg": "#ffc67a", "md-line": "rgba(255,152,15,.45)",
        "lo-bg": "rgba(255,255,255,.08)", "lo-fg": "#b8c1cc", "lo-line": "rgba(255,255,255,.2)",
        "un-fg": "#aab3be", "un-line": "rgba(255,255,255,.3)",
        "pick-bg": "rgba(255,152,15,.17)", "cream": "rgba(255,204,51,.1)", "logo-ink": "#f3f5f7",
        "font": "-apple-system,BlinkMacSystemFont,\"SF Pro Text\",system-ui,sans-serif", "mono": "ui-monospace,\"SF Mono\",Menlo,monospace",
    ]
}
