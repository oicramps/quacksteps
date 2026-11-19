import Foundation
import Testing
@testable import QuackProtocol

/// shared/fixtures/messages.json is generated from typed TypeScript examples; these tests make the
/// Swift types agree with it in both directions.
nonisolated(unsafe) private let fixtures: [String: Any] = {
    let url = URL(filePath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "shared/fixtures/messages.json")
    let data = try! Data(contentsOf: url)
    return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
}()

private func data(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object) }

@Test func everyServerFixtureDecodesAsItsOwnType() throws {
    let messages = fixtures["serverMessages"] as! [[String: Any]]
    #expect(messages.count > 10)
    for m in messages {
        let decoded = try JSONDecoder().decode(ServerMessage.self, from: data(m))
        if case let .unknown(type, _) = decoded { Issue.record("decoded \(type) as unknown") }
        #expect(decoded.requestId == m["requestId"] as? String)
    }
}

@Test func inboxFixtureKeepsItsDetails() throws {
    let raw = (fixtures["serverMessages"] as! [[String: Any]]).first { $0["type"] as? String == "inbox" }!
    guard case let .inbox(inbox) = try JSONDecoder().decode(ServerMessage.self, from: data(raw)) else { Issue.record("not inbox"); return }
    #expect(inbox.items.count == 4)
    #expect(inbox.items[0].review?.phase == .ready)
    #expect(inbox.items[0].reviewer?.via == .team)
    #expect(inbox.items[1].author?.state == .waitingOnMe)
    #expect(inbox.items[2].author?.state == nil)
    #expect(inbox.items[3].reviewer?.isRequested == false)
    #expect(inbox.items[3].stack?.position == 2 && inbox.items[3].stack?.parent?.number == 4127)
    #expect(inbox.items[0].stack == nil)
    #expect(inbox.items[0].reviewer?.isRequested == true)
    #expect(inbox.events.count == 4)
    #expect(inbox.error?.code == .rateLimited)
    #expect(ISODate.parse(inbox.fetchedAt) != nil)
    #expect(ISODate.parse(inbox.items[0].reviewer!.requestedAt) != nil, "timestamps without fractional seconds parse too")
}

@Test func unknownMessageTypesDoNotThrow() throws {
    let decoded = try JSONDecoder().decode(ServerMessage.self, from: Data(#"{"type":"something_new","requestId":"z"}"#.utf8))
    guard case .unknown("something_new", "z") = decoded else { Issue.record("expected unknown"); return }
}

@Test func everyAppFixtureIsWhatTheAppSends() throws {
    let expected = fixtures["appMessages"] as! [[String: Any]]
    let pr = PrKey(owner: "acme", repo: "web", number: 4127)
    let sha = "a41c9e2b7d3f4e5a6b7c8d9e0f1a2b3c4d5e6f7a"
    let sent: [(AppRequest, String)] = [
        (.hello(clientVersion: "0.2.6"), "h1"),
        (.subscribe(.inbox), "s1"),
        (.subscribe(.agents), "s2"),
        (.subscribe(.pr(pr)), "s3"),
        (.unsubscribe, "s3"),
        (.inbox(refresh: true), "i1"),
        (.startReview(pr, agent: .cursor, model: ""), "r1"),
        (.stopReview(pr, removeWorktree: true), "r2"),
        (.updateReview(pr), "r3"),
        (.riskLabels(pr, headSha: nil, rerun: true), "l1"),
        (.prDiff(pr, headSha: sha), "d1"),
        (.threads(pr), "t1"),
        (.ask(agent: .cursor, model: "", pr: PrRef(pr, headSha: sha), selections: [CodeSelection(path: "src/map.ts", side: .new, startLine: 47, endLine: 51)], question: "Why cluster here?", sessionId: nil), "a1"),
        (.ask(agent: .claudeCode, model: "", pr: PrRef(pr, headSha: sha), selections: [], question: "And the tests?", sessionId: nil, history: [HistoryTurn(question: "Why cluster here?", answer: "Because pins overlap.")]), "a2"),
        (.cancel, "a1"),
        (.closeSession(agent: .cursor, sessionId: "s-1"), "cs1"),
        (.shutdown, "x1"),
        (.setupChecks, "c1"),
        (.settings, "g1"),
        (.saveSettings(SettingsPatch(retentionDays: 14, maxWorktrees: 20, chatAgent: .some(.cursor), chatModel: "auto", labelsAgent: .some(nil), labelsModel: "fast", extraPath: ["~/bin"], pollActiveSeconds: 60, pollIdleSeconds: 300)), "g2"),
        (.pruneWorktrees, "g3"),
        (.diagnostics, "g4"),
        (.addScanFolder("/Users/dev/code"), "w1"),
    ]
    #expect(sent.count == expected.count)
    for ((request, id), want) in zip(sent, expected) {
        let got = request.json(requestId: id) as NSDictionary
        #expect(got.isEqual(to: want), "\(want["type"] ?? "?"): \(got) != \(want)")
    }
}

@Test func topicsRoundTrip() throws {
    for topic in [SubscriptionTopic.inbox, .agents, .pr(PrKey(owner: "a", repo: "b", number: 1))] {
        let back = try JSONDecoder().decode(SubscriptionTopic.self, from: JSONEncoder().encode(topic))
        #expect(back == topic)
    }
}

@Test func settingsFixtureDecodesNullsAndSizes() throws {
    let raw = (fixtures["serverMessages"] as! [[String: Any]]).first { $0["type"] as? String == "settings" }!
    guard case let .settings(m) = try JSONDecoder().decode(ServerMessage.self, from: data(raw)) else { Issue.record("not settings"); return }
    #expect(m.settings.labelsAgent == nil)
    #expect(m.settings.chatAgent == .cursor)
    #expect(m.worktrees.bytes == 6_657_199_308)
    #expect(m.clones[1].path == nil)
}

@Test func closedReviewsDecode() throws {
    let raw = (fixtures["serverMessages"] as! [[String: Any]]).first { m in
        ((m["review"] as? [String: Any])?["closed"]) != nil
    }!
    guard case let .review(m) = try JSONDecoder().decode(ServerMessage.self, from: data(raw)) else { Issue.record("not review"); return }
    #expect(m.review?.closed?.state == .merged)
    #expect(m.review?.closed?.by == "noor")
}

@Test func staleReviewsCarryTheirCommitCount() throws {
    let raw = (fixtures["serverMessages"] as! [[String: Any]]).first { m in
        ((m["review"] as? [String: Any])?["newCommits"]) != nil
    }!
    guard case let .review(m) = try JSONDecoder().decode(ServerMessage.self, from: data(raw)) else { Issue.record("not review"); return }
    #expect(m.review?.phase == .stale && m.review?.newCommits == 3)
}
