import QuackProtocol
import Testing
@testable import QuackStores

// Synthetic data only: this repo is public.
private let old = "@@ -0,0 +1,4 @@\n+let a = 1\n+let b = 2\n+let c = 3\n+let d = 4\n"

@Test func unchangedLinesFollowTheirComment() {
    // Two lines inserted above: b and c move down by two.
    let new = "@@ -0,0 +1,6 @@\n+// header\n+// more\n+let a = 1\n+let b = 2\n+let c = 3\n+let d = 4\n"
    let anchor = CommentAnchor(path: "a.swift", side: .right, line: 3, startLine: 2)
    #expect(DraftRemap.remap(anchor, oldPatch: old, newPatch: new) == .moved(CommentAnchor(path: "a.swift", side: .right, line: 5, startLine: 4)))
}

@Test func changedLinesAreOutdated() {
    let new = "@@ -0,0 +1,4 @@\n+let a = 1\n+let b = 20\n+let c = 3\n+let d = 4\n"
    let anchor = CommentAnchor(path: "a.swift", side: .right, line: 2)
    #expect(DraftRemap.remap(anchor, oldPatch: old, newPatch: new) == .outdated(old: ["let b = 2"], now: ["let b = 20"]))
    #expect(DraftRemap.remap(anchor, oldPatch: old, newPatch: nil) == .outdated(old: ["let b = 2"], now: []), "the file left the diff")
}

@Test func nearestCopyWins() {
    let new = "@@ -0,0 +1,5 @@\n+let b = 2\n+let a = 1\n+let x = 9\n+let b = 2\n+let d = 4\n"
    let anchor = CommentAnchor(path: "a.swift", side: .right, line: 2)
    #expect(DraftRemap.remap(anchor, oldPatch: old, newPatch: new) == .moved(CommentAnchor(path: "a.swift", side: .right, line: 1)))
}

@Test func sidesAreReadSeparately() {
    let patch = "@@ -3,3 +3,3 @@\n same\n-gone\n+came\n tail\n"
    #expect(DraftRemap.lines(patch, side: .left) == [3: "same", 4: "gone", 5: "tail"])
    #expect(DraftRemap.lines(patch, side: .right) == [3: "same", 4: "came", 5: "tail"])
}
