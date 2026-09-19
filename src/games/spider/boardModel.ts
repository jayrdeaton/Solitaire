import { columnBoardModel } from '@/components/gameLayout'

/** The tallest tableau column at the START of a deal. rules.ts deals [6, 6, 6, 6, 5, 5, 5, 5, 5, 5]
 * cards with only the last one face-up, so the four 6-card columns are the tallest: 5 face-down + 1
 * face-up. Identical for every suit count - the suit setting only changes which cards those are. */
export const TALLEST_COLUMN = { faceDown: 5, faceUp: 1 }

/** SpiderScreen's board: the row above the tableau is exactly one card tall (the 8 completed-sequence
 * slots and the stock fan sit side by side in it, and the fan is one card high), followed by its
 * marginBottom 16; then the 10 tableau columns.
 *
 * Default headroom on purpose. Every stock deal adds one face-up card to each column (up to 5 of them),
 * but Spider is 10 cards wide, so on a phone held sideways the WIDTH runs out first (56pt cards at
 * 874x402) and this height fit is a no-op there (see boardModel.test.ts) - padding the budget for the
 * stock deals would only shrink cards on the rare short window where the height does bind, and a
 * column that outgrows the budget just compresses like it always has. The tableau row's own
 * paddingBottom is 24 in portrait but the shared 20 in the wide layout (SpiderScreen overrides it
 * there so useTableauMaxHeight's budget adds up exactly), which is what the default models. */
export const BOARD_MODEL = columnBoardModel({ ...TALLEST_COLUMN })
