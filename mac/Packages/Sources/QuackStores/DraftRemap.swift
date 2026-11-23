import Foundation
import QuackProtocol

/// Following pending comments to a new commit (canvas "New commits mid-review").
/// A comment whose lines are unchanged moves with them, silently; one whose lines changed is outdated.
public enum DraftRemap {
    /// Line number -> text on one side of a unified patch (RIGHT: added and context; LEFT: removed and context).
    public static func lines(_ patch: String, side: DiffSide) -> [Int: String] {
        var out: [Int: String] = [:]
        var old = 0, new = 0
        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("@@") {
                // @@ -a,b +c,d @@
                let parts = line.split(separator: " ")
                if parts.count >= 3 {
                    old = Int(parts[1].dropFirst().split(separator: ",")[0]) ?? 0
                    new = Int(parts[2].dropFirst().split(separator: ",")[0]) ?? 0
                }
                continue
            }
            guard old > 0 || new > 0 else { continue }
            if line.hasPrefix("+") {
                if side == .right { out[new] = String(line.dropFirst()) }
                new += 1
            } else if line.hasPrefix("-") {
                if side == .left { out[old] = String(line.dropFirst()) }
                old += 1
            } else if line.hasPrefix(" ") {
                out[side == .right ? new : old] = String(line.dropFirst())
                old += 1
                new += 1
            }
        }
        return out
    }

    public enum Result: Equatable, Sendable {
        /// The lines are still there (maybe moved): the comment follows them.
        case moved(CommentAnchor)
        /// The lines changed. `now` is what the same line numbers hold now, if anything.
        case outdated(old: [String], now: [String])
    }

    /// Where `anchor` (on `oldPatch`) belongs in `newPatch`.
    public static func remap(_ anchor: CommentAnchor, oldPatch: String, newPatch: String?) -> Result {
        let start = anchor.startLine ?? anchor.line
        let oldLines = lines(oldPatch, side: anchor.side)
        let text = (start...anchor.line).compactMap { oldLines[$0] }
        let newLines = newPatch.map { lines($0, side: anchor.side) } ?? [:]
        let now = (start...anchor.line).compactMap { newLines[$0] }
        guard text.count == anchor.line - start + 1, !newLines.isEmpty else { return .outdated(old: text, now: now) }
        // The same run of lines, nearest to where it was.
        let span = anchor.line - start
        let candidates = newLines.keys.filter { n in (0...span).allSatisfy { newLines[n + $0] == text[$0] } }
        guard let best = candidates.min(by: { abs($0 - start) < abs($1 - start) }) else { return .outdated(old: text, now: now) }
        return .moved(CommentAnchor(path: anchor.path, side: anchor.side, line: best + span, startLine: span > 0 ? best : nil))
    }
}
