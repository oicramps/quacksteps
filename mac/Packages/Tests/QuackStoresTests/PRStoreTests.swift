import Foundation
import QuackClient
import QuackProtocol
import Testing
@testable import QuackStores

private func decode<T: Decodable>(_ json: String) -> T { try! JSONDecoder().decode(T.self, from: Data(json.utf8)) }

private let pr = PrKey(owner: "acme", repo: "web", number: 7)
private let diff: PrDiffMessage = decode(#"""
{"requestId":"d","pr":{"owner":"acme","repo":"web","number":7},"baseSha":"b","headSha":"h1","files":[
 {"path":"src/a.ts","status":"modified","additions":10,"deletions":2,"binary":false,"truncated":false},
 {"path":"yarn.lock","status":"modified","additions":40,"deletions":30,"binary":false,"truncated":false},
 {"path":"src/b.ts","status":"added","additions":5,"deletions":0,"binary":false,"truncated":false},
 {"path":"README.md","status":"modified","additions":1,"deletions":1,"binary":false,"truncated":false}]}
"""#)
private func labels(head: String, previous: String? = nil) -> RiskLabelsMessage {
    decode(#"""
    {"requestId":"l","pr":{"owner":"acme","repo":"web","number":7},"headSha":"\#(head)","status":"ready","agent":"cursor","model":"","files":[
     {"path":"src/b.ts","risk":"high","reason":"Auth","rank":0,"source":"agent"},
     {"path":"src/a.ts","risk":"medium","reason":"Logic","rank":1,"source":"agent"},
     {"path":"yarn.lock","risk":"low","reason":"Lockfile","rank":2,"source":"rule"}]\#(previous.map { #","previousHeadSha":"\#($0)""# } ?? "")}
    """#)
}

@MainActor private func store(labels: RiskLabelsMessage?) -> PRStore {
    let model = AppModel(preview: nil, connection: .connecting)
    return PRStore(preview: pr, model: model, review: nil, labels: labels, diff: diff)
}

@MainActor @Test func withoutLabelsFilesStayInDiffOrder() {
    let s = store(labels: nil)
    #expect(s.rankedFiles.map(\.path) == ["src/a.ts", "yarn.lock", "src/b.ts", "README.md"])
    #expect(s.sections.map(\.risk) == [.unlabeled])
    #expect(s.totals.files == 4 && s.totals.additions == 56 && s.totals.deletions == 33)
}

@MainActor @Test func labelsRankFilesAndGroupThem() {
    let s = store(labels: labels(head: "h1"))
    #expect(s.rankedFiles.map(\.path) == ["src/b.ts", "src/a.ts", "yarn.lock", "README.md"], "files the labels miss go last")
    #expect(s.sections.map(\.risk) == [.high, .medium, .low, .unlabeled])
    #expect(s.labelsAreCurrent)
    #expect(s.rankedFiles[0].folder == "src/" && s.rankedFiles[3].folder == "/")
}

@MainActor @Test func labelsForAnotherCommitAreNotCurrent() {
    #expect(!store(labels: labels(head: "h0")).labelsAreCurrent)
    #expect(!store(labels: labels(head: "h1", previous: "h0")).labelsAreCurrent, "running for this commit, showing older ones")
}

@MainActor @Test func cachedLabelsShowWithoutAReviewOnlyForTheCommitOnScreen() {
    // Not reviewing, labels cached for this exact commit: ranked, like the diff shows them.
    let cached = store(labels: labels(head: "h1"))
    #expect(cached.visibleLabels != nil)
    #expect(cached.sections.first?.risk == .high)
    // Not reviewing, labels for another commit: hidden in both the sidebar and the diff.
    let other = store(labels: labels(head: "h0"))
    #expect(other.visibleLabels == nil)
    #expect(other.sections.map(\.risk) == [.unlabeled])
}
