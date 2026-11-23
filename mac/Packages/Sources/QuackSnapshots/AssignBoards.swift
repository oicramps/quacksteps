import QuackUI
import SwiftUI

/// Board for "Start reviewing → assign": the prompt sheet, light and dark. Synthetic public data.
@MainActor
func assignBoards() {
    snapshot("assign-prompt", size: CGSize(width: 480, height: 190)) {
        AssignPromptPreview().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
