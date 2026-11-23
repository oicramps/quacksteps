import QuackProtocol
import SwiftUI

/// Three small vertical bars: 3 filled for High, 2 Med, 1 Low; outlined for Unlabeled or nil.
public struct RiskBars: View {
    var risk: FileRisk.Risk?
    public init(_ risk: FileRisk.Risk?) { self.risk = risk }

    private var level: Int {
        switch risk {
        case .high: 3
        case .medium: 2
        case .low: 1
        case .unlabeled, nil: 0
        }
    }

    static func color(_ risk: FileRisk.Risk?) -> Color {
        switch risk {
        case .high: Tokens.danger
        case .medium: Tokens.beak
        case .low: Tokens.lowText
        case .unlabeled, nil: .secondary
        }
    }

    public var body: some View {
        let color = Self.color(risk)
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<3, id: \.self) { index in
                let height = CGFloat(5 + index * 3)
                if level == 0 {
                    RoundedRectangle(cornerRadius: 1)
                        .strokeBorder(color.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [2, 1.5]))
                        .frame(width: 3, height: height)
                } else {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(index < level ? color : color.opacity(0.25))
                        .frame(width: 3, height: height)
                }
            }
        }
        .frame(width: 13, height: 11, alignment: .bottomLeading)
        .accessibilityHidden(true)
    }
}

/// Capsule, 18 pt: bars plus the word. Colour only reinforces the bar count and the label.
public struct RiskBadge: View {
    var risk: FileRisk.Risk
    public init(_ risk: FileRisk.Risk) { self.risk = risk }

    private var label: String {
        switch risk {
        case .high: "High"
        case .medium: "Med"
        case .low: "Low"
        case .unlabeled: "Unlabeled"
        }
    }

    private var style: (foreground: Color, background: Color, line: Color) {
        switch risk {
        case .high: (Tokens.danger, Tokens.highBg, Tokens.highLine)
        case .medium: (Tokens.warning, Tokens.medBg, Tokens.medLine)
        case .low: (Tokens.lowText, Tokens.lowBg, .clear)
        case .unlabeled: (.secondary, .clear, Color(nsColor: .separatorColor))
        }
    }

    public var body: some View {
        let s = style
        HStack(spacing: 5) {
            RiskBars(risk)
            Text(label)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(s.foreground)
        .padding(.horizontal, 7)
        .frame(height: 18)
        .background(s.background, in: Capsule())
        .overlay(Capsule().strokeBorder(s.line))
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(risk == .unlabeled ? "No risk label" : "\(label) risk")
    }
}

/// Marks a file labelled by a rule instead of the agent.
public struct RuleTag: View {
    public init() {}

    public var body: some View {
        Text("rule")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .frame(height: 15)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color(nsColor: .separatorColor)))
            .fixedSize()
            .help("Labelled by a rule, not the agent")
            .accessibilityLabel("Labelled by rule")
    }
}

#Preview("Risk badges") {
    VStack(alignment: .leading, spacing: 10) {
        HStack { ForEach(FileRisk.Risk.allCases, id: \.self) { RiskBadge($0) } }
        HStack(spacing: 14) { RiskBars(.high); RiskBars(.medium); RiskBars(.low); RiskBars(.unlabeled); RiskBars(nil); RuleTag() }
    }
    .padding(20)
}
