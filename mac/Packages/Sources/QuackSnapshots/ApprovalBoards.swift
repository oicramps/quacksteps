import Foundation
import QuackProtocol
import QuackStores
import QuackUI
import SwiftUI

/// Human vs bot approvals: a stack of my PRs (approved by a person, by a bot only, not yet) and a
/// review request only a bot approved (still waiting on me). Synthetic data only: this repo is public.
@MainActor
func approvalBoards() {
    func item(_ number: Int, _ title: String, role: String, approvals: [(String, Bool)], stack: (Int, Int, Int?)? = nil, state: String? = "waiting_on_reviewers") -> [String: Any] {
        var d: [String: Any] = [
            "pr": ["owner": "acme", "repo": "web", "number": number], "title": title, "url": "https://github.com/acme/web/pull/\(number)",
            "authorLogin": role == "author" ? "dev" : "noor-test", "isDraft": false, "headSha": String(repeating: "a", count: 40), "baseRef": "main",
            "updatedAt": iso(hoursAgo: 2), "additions": 120, "deletions": 30, "role": role, "ci": "passing",
            "approvals": approvals.map { ["login": $0.0, "bot": $0.1] },
        ]
        if role == "author" { d["author"] = ["state": state as Any, "since": iso(hoursAgo: 30), "reasons": []] }
        else { d["reviewer"] = ["requestedAt": iso(hoursAgo: 26), "via": "user"] }
        if let stack { d["stack"] = ["position": stack.0, "size": stack.1, "parent": stack.2.map { ["number": $0, "title": "Below"] } as Any] }
        return d
    }
    let items: [[String: Any]] = [
        item(4140, "Header search: limit the query", role: "reviewer", approvals: [("coderabbitai", true)]),
        item(4201, "[DS] Add CompactCard component", role: "author", approvals: [("noor-test", false), ("coderabbitai", true)], stack: (1, 3, nil), state: "ready_to_merge"),
        item(4202, "Day trips: search mode", role: "author", approvals: [("coderabbitai", true)], stack: (2, 3, 4201)),
        item(4203, "Day trips: parent picker", role: "author", approvals: [], stack: (3, 3, 4202)),
    ]
    let json: [String: Any] = ["requestId": "p", "fetchedAt": iso(hoursAgo: 0.01), "items": items, "events": []]
    guard let data = try? JSONSerialization.data(withJSONObject: json), let message = try? JSONDecoder().decode(InboxMessage.self, from: data) else {
        print("approval boards: bad preview data")
        return
    }
    let model = AppModel(preview: message, connection: .connected(hello))
    snapshot("inbox-approvals", size: CGSize(width: 1200, height: 520)) { InboxView(model: model, openPR: { _ in }, openSetup: {}, openStacks: true) }
}
