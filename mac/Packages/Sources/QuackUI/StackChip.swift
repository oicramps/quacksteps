import QuackProtocol
import SwiftUI

/// "Stack 2/3": where a PR sits in a stack of PRs. Position 1 is the bottom.
public struct StackChip: View {
    var stack: StackInfo

    public init(_ stack: StackInfo) { self.stack = stack }

    private var isBase: Bool { stack.position <= 1 }
    private var bars: Int { max(2, min(stack.size, 3)) }
    /// Bar index from the top (0) of the icon that stands for this PR.
    private var filledBar: Int { bars - min(max(stack.position, 1), bars) }

    public var body: some View {
        HStack(spacing: 4) {
            VStack(spacing: 2) {
                ForEach(0 ..< bars, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(index == filledBar ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary.opacity(0.55)))
                        .frame(width: 12, height: 4)
                }
            }
            .frame(width: 12, height: bars == 2 ? 10 : 16)
            .accessibilityHidden(true)
            Text(verbatim: "Stack \(stack.position)/\(stack.size)")
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(isBase ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(isBase ? AnyShapeStyle(Tokens.fill) : AnyShapeStyle(Color.accentColor.opacity(0.13)), in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "Stack: PR \(stack.position) of \(stack.size)"))
    }
}
