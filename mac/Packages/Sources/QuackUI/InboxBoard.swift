import QuackProtocol
import QuackStores
import SwiftUI

// The inbox as a departures board (canvas "animated waiting indicator options", Full example):
// fixed columns on the right, the wait on yellow-on-ink split-flap tiles, size on light tiles,
// one mono status word. Animations play once when a value first shows and again when it changes.

enum BoardColumns {
    static let ci: CGFloat = 16
    static let size: CGFloat = 104
    static let wait: CGFloat = 49
    static let status: CGFloat = 76
    static let spacing: CGFloat = 12

    static let boardInk = Color.dynamic(light: NSColor(hex: 0x1c222e), dark: NSColor(hex: 0x0f1115))
    /// Review bots (approved, but not counted): a muted violet, apart from the human green.
    static let botInk = Color.dynamic(light: NSColor(hex: 0x6d4fc2), dark: NSColor(hex: 0xb7a3f0))
}

/// "CI   SIZE  WAIT  STATUS" over a section, lined up with the row columns.
struct BoardColumnHeaders: View {
    var waitTitle: String

    var body: some View {
        HStack(spacing: BoardColumns.spacing) {
            Text("CI").frame(width: BoardColumns.ci, alignment: .center)
            Text("SIZE").frame(width: BoardColumns.size, alignment: .trailing)
            // "IN STATE" is wider than the tiles: it runs into the gap on its right, as on the canvas.
            Text(waitTitle).fixedSize().frame(width: BoardColumns.wait, alignment: .leading)
            Text("STATUS").frame(width: BoardColumns.status, alignment: .leading)
        }
        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
        .tracking(0.95)
        .foregroundStyle(.tertiary)
        .lineLimit(1)
        .fixedSize()
        .accessibilityHidden(true)
    }
}

/// The right-hand columns of a row (or of a collapsed stack, with its summary values).
struct BoardCells: View {
    /// Keys the flap animation, so it plays once per row and value.
    var key: String
    var ci: CIState
    var lines: Int
    var since: Date?
    var status: (Date) -> BoardStatus
    var totalSize: Bool = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let waited = since.map { context.date.timeIntervalSince($0) }
            let status = status(context.date)
            HStack(spacing: BoardColumns.spacing) {
                CIGlyph(ci).frame(width: BoardColumns.ci)
                SizeCell(lines: lines, total: totalSize).frame(width: BoardColumns.size, alignment: .trailing)
                FlapText(waited.map(BoardFormat.flaps) ?? BoardFormat.noTimer, key: key, dim: waited == nil)
                    .frame(width: BoardColumns.wait, alignment: .leading)
                    .help(waited.map { "Waiting \(WaitFormat.spoken($0))" } ?? "Draft: no timer")
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(waited.map { "Waiting \(WaitFormat.spoken($0))" } ?? "Draft, no timer")
                StatusWord(status).frame(width: BoardColumns.status, alignment: .leading)
            }
        }
    }
}

/// "340 lines  M": the line count, then the size letter on light flap tiles. Only L and XL get colour.
struct SizeCell: View {
    var lines: Int
    var total: Bool = false

    var body: some View {
        let size = PRSize(lines: lines)
        let (bg, fg): (Color, Color) = switch size {
        case .l: (Tokens.medBg, Tokens.warning)
        case .xl: (Tokens.highBg, Tokens.danger)
        default: (Tokens.fill2, .secondary)
        }
        HStack(spacing: 6) {
            Text(verbatim: "\(lines.formatted()) lines")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            HStack(spacing: 2) {
                ForEach(Array(size.rawValue.count == 1 ? [" ", size.rawValue] : size.rawValue.map(String.init)).enumerated(), id: \.offset) { _, c in
                    Text(verbatim: c)
                        .font(.system(size: 13, weight: .bold, design: .monospaced))
                        .foregroundStyle(fg)
                        .frame(width: 15, height: 22)
                        .background(bg, in: RoundedRectangle(cornerRadius: 3))
                }
            }
        }
        .fixedSize()
        .help("\(size.rawValue): \(lines.formatted()) changed lines\(total ? " in the stack" : "")")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(size.rawValue), \(lines.formatted()) changed lines\(total ? " in total" : "")")
    }
}

/// The status word in mono caps.
struct StatusWord: View {
    var status: BoardStatus
    init(_ status: BoardStatus) { self.status = status }

    var body: some View {
        Text(verbatim: status.word)
            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
            .tracking(0.63)
            .foregroundStyle(Self.color(status.tone))
            .lineLimit(1)
            .fixedSize()
    }

    static func color(_ tone: BoardStatus.Tone) -> AnyShapeStyle {
        switch tone {
        case .dim: AnyShapeStyle(.tertiary)
        case .ok: AnyShapeStyle(.secondary)
        case .green: AnyShapeStyle(Tokens.success)
        case .orange: AnyShapeStyle(Tokens.warning)
        case .red: AnyShapeStyle(Tokens.danger)
        }
    }
}

/// Small rounded tag under a row's title: "Stack 1/2", "Reviewing", "2 new commits".
struct BoardTag: View {
    /// `bot`: a review bot's approval — shown, but never the approval a PR needs.
    enum Kind { case plain, accent, orange, red, green, bot }
    var text: String
    var kind: Kind = .plain

    var body: some View {
        let (fg, bg): (AnyShapeStyle, AnyShapeStyle) = switch kind {
        case .plain: (AnyShapeStyle(.secondary), AnyShapeStyle(Tokens.fill))
        case .accent: (AnyShapeStyle(.tint), AnyShapeStyle(Color.accentColor.opacity(0.13)))
        case .orange: (AnyShapeStyle(Tokens.warning), AnyShapeStyle(Tokens.fill))
        case .red: (AnyShapeStyle(Tokens.danger), AnyShapeStyle(Tokens.highBg))
        case .green: (AnyShapeStyle(Tokens.success), AnyShapeStyle(Tokens.greenBg))
        case .bot: (AnyShapeStyle(BoardColumns.botInk), AnyShapeStyle(BoardColumns.botInk.opacity(0.13)))
        }
        HStack(spacing: 3) {
            if kind == .bot { Image(systemName: "cpu").font(.system(size: 9, weight: .semibold)) }
            Text(verbatim: text)
        }
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(fg)
            .padding(.horizontal, 6)
            .frame(height: 16)
            .background(bg, in: RoundedRectangle(cornerRadius: 5))
            .lineLimit(1)
            .fixedSize()
    }
}

// MARK: - Split-flap tiles

/// What each tile last showed, so a row scrolled back into view doesn't replay its flip, and a changed
/// value flips even when the row was rebuilt.
@MainActor private enum FlapMemory {
    static var shown: [String: Character] = [:]
}

/// Yellow-on-ink flap tiles. On first show each tile riffles through a few earlier characters; when the
/// value changes, the changed tiles flip four times. Reduce Motion: no flips.
struct FlapText: View {
    var text: String
    var key: String
    var dim: Bool

    init(_ text: String, key: String, dim: Bool = false) {
        self.text = text
        self.key = key
        self.dim = dim
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(text.enumerated()), id: \.offset) { index, c in
                FlapTile(target: c, key: "\(key)#\(index)", seed: abs(key.hashValue % 7) + index * 3, dim: dim)
            }
        }
        .fixedSize()
    }
}

private struct FlapTile: View {
    var target: Character
    var key: String
    var seed: Int
    var dim: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown: Character?
    @State private var flipping = false

    private static let sets = ["0123456789", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map { Array($0) }

    var body: some View {
        Text(String(shown ?? target))
            .font(.system(size: 13, weight: .bold, design: .monospaced))
            .foregroundStyle(dim ? AnyShapeStyle(Color.white.opacity(0.3)) : AnyShapeStyle(Tokens.quackYellow))
            .frame(width: 15, height: 22)
            .background(BoardColumns.boardInk, in: RoundedRectangle(cornerRadius: 3))
            .overlay { Rectangle().fill(.black.opacity(0.55)).frame(height: 1) }
            .brightness(flipping ? -0.35 : 0)
            .rotation3DEffect(.degrees(flipping ? -82 : 0), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
            .task(id: target) { await run() }
            .accessibilityHidden(true)
    }

    @MainActor private func run() async {
        let previous = FlapMemory.shown[key]
        FlapMemory.shown[key] = target
        guard !reduceMotion, !dim, let set = Self.sets.first(where: { $0.contains(target) }) else {
            shown = target
            return
        }
        let steps: Int
        if previous == nil { steps = 3 + seed % 5 }  // first time this row shows: riffle in
        else if previous != target { steps = 4 }      // the value changed
        else { shown = target; return }
        let at = set.firstIndex(of: target)!
        for back in stride(from: steps, through: 0, by: -1) {
            shown = set[(at - back + set.count * 10) % set.count]
            flipping = true
            withAnimation(.linear(duration: 0.075)) { flipping = false }
            if back > 0 { try? await Task.sleep(for: .milliseconds(70)) }
            if Task.isCancelled { shown = target; return }
        }
    }
}

// MARK: - Stacks as a tree

/// The collapsed (or open) head of a stack: chevron, name, "Stack · 3 PRs", one pip per PR, progress,
/// then the stack's summary in the board columns.
struct StackHeaderRow: View {
    var group: StackGroup
    var expanded: Bool
    var toggle: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: toggle) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .background(Tokens.fill2, in: RoundedRectangle(cornerRadius: 7))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(expanded ? "Collapse" : "Expand") \(group.name) stack")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    Text(group.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    BoardTag(text: "Stack · \(group.items.count) PRs")
                }
                HStack(spacing: 8) {
                    Text(meta).lineLimit(1)
                    HStack(spacing: 2) {
                        ForEach(group.items) { item in
                            Capsule().fill(pipColor(item)).frame(width: 14, height: 4)
                        }
                    }
                    .accessibilityHidden(true)
                    .help("Green: approved by a person · Violet: approved by a bot only · Grey: not yet")
                    Text(progress).fixedSize()
                }
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            BoardCells(key: group.id, ci: group.worstCI, lines: group.totalLines, since: group.oldestWait,
                       status: { group.mostUrgentStatus(now: $0) }, totalSize: true)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(group.name), stack of \(group.items.count) PRs. \(progress)")
    }

    private var isReview: Bool { group.items.first?.role == .reviewer }

    private var meta: String {
        let first = group.items[0]
        let authors = Set(group.items.map(\.authorLogin))
        let who = authors.count == 1 ? first.authorLogin : "\(authors.count) authors"
        return isReview ? "\(who) · \(first.pr.repo) · review from the top down" : first.pr.repo
    }

    private var progress: String {
        let n = group.items.count
        if isReview {
            if let i = group.items.firstIndex(where: { $0.review != nil }) { return "Reviewing \(i + 1) of \(n)" }
            let done = group.items.filter { $0.reviewer?.isRequested == false }.count
            return done > 0 ? "\(done) of \(n) reviewed" : "\(n) to review"
        }
        // Approved = a human approved. Bot-only approvals are counted apart.
        let approved = group.items.filter { !$0.humanApprovals.isEmpty }.count
        let botOnly = group.items.filter { $0.humanApprovals.isEmpty && !$0.botApprovals.isEmpty }.count
        return "\(approved) of \(n) approved" + (botOnly > 0 ? " · \(botOnly) by a bot only" : "")
    }

    /// Green: a person approved (or, for my review requests, I already reviewed it). Violet: only a bot
    /// approved. Blue: I'm reviewing it. Grey: not yet.
    private func pipColor(_ item: InboxItem) -> Color {
        if !item.humanApprovals.isEmpty || item.reviewer?.isRequested == false { return Tokens.success }
        if !item.botApprovals.isEmpty { return BoardColumns.botInk }
        if item.review != nil { return .accentColor }
        return Tokens.fill2
    }
}

/// The tree connector in place of a stack member's avatar: ├─ for middle members, a rounded └─ for the last.
struct TreeLane: View {
    var isLast: Bool

    var body: some View {
        Canvas { context, size in
            let x: CGFloat = 12, mid = size.height / 2, end: CGFloat = 26, r: CGFloat = 7
            var path = Path()
            path.move(to: CGPoint(x: x, y: -14))
            if isLast {
                path.addLine(to: CGPoint(x: x, y: mid - r))
                path.addQuadCurve(to: CGPoint(x: x + r, y: mid), control: CGPoint(x: x, y: mid))
                path.addLine(to: CGPoint(x: end, y: mid))
            } else {
                path.addLine(to: CGPoint(x: x, y: size.height + 14))
                path.move(to: CGPoint(x: x, y: mid))
                path.addLine(to: CGPoint(x: end, y: mid))
            }
            context.stroke(path, with: .color(.primary.opacity(0.2)), lineWidth: 2)
        }
        .frame(width: 24)
        .frame(maxHeight: .infinity)
        .accessibilityHidden(true)
    }
}
