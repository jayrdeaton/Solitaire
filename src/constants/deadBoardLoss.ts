// Whether a dead board ends the deal (games/shared/useStuckLossCheck.ts): the No Moves Left dialog, the clock stopping,
// Hint turned off, and a loss recorded when the player leaves it. Off for now (Jay, 2026-10-23: the dialog came up before
// he had any chance to puzzle at the board), in every game, the exact no-moves check of Aces Up, Golf, TriPeaks, Forty
// Thieves and Scorpion included. Off, a dead board plays on like any other: the clock runs, Hint says it has nothing to
// suggest, the board is saved, and New Game records the loss as a deal walked away from. Turn it back on here.
export const DEAD_BOARD_LOSS = false
