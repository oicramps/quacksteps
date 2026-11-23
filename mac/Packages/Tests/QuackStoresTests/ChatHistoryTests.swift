import Foundation
import QuackProtocol
import Testing
@testable import QuackStores

@Test func historyKeepsTheLastEightFinishedTurnsTrimmed() {
    var turns = (1...10).map { ChatTurn(question: "q\($0)", answer: "a\($0)", agent: .cursor) }
    turns.append(ChatTurn(question: "failed", answer: "partial", agent: .cursor, status: .failed(code: .cancelled, message: "Stopped.", fixSteps: [])))
    turns.append(ChatTurn(question: "long", answer: String(repeating: "x", count: 5000), agent: .cursor))
    let history = PRStore.history(from: turns)
    #expect(history.count == 8)
    #expect(history.first?.question == "q4")
    #expect(!history.contains { $0.question == "failed" }, "failed turns are not history")
    #expect(history.last?.answer.count == 4001, "long answers are trimmed")
}
