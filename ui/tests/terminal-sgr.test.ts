/**
 * Cell-snapshot -> SGR tests for the docked terminals.
 *
 * The bridge does not stream PTY bytes to the HUD; it sends whole screen
 * snapshots, and `cellsToSgr` repaints them into xterm. That makes this function
 * the single place where bridge cell colors become visible colors, and the
 * field names it reads (`fg.t`, `fg.i`, `fg.r/g/b`) are exactly the wire names
 * `yuppycode-cli` emits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cellsToSgr } from "@/lib/term";
import type { CellColorDto, TerminalCellDto } from "@/lib/protocol";

const RESET = "[0m";

function cell(ch: string, over: Partial<TerminalCellDto> = {}): TerminalCellDto {
  return {
    ch,
    fg: { t: "default" },
    bg: { t: "default" },
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    wide: false,
    ...over,
  };
}

function render(cells: TerminalCellDto[], rows = 1, cols = cells.length): string {
  return cellsToSgr(cells, rows, cols);
}

test("plain text is emitted with a single trailing reset", () => {
  assert.equal(render([cell("h"), cell("i")]), `hi${RESET}`);
});

test("style changes wrap only the run they apply to", () => {
  assert.equal(render([cell("h"), cell("i", { bold: true })]), `h[1mi${RESET}`);
  assert.equal(
    render([cell("a", { bold: true }), cell("b")]),
    `[1ma[22mb${RESET}`,
    "bold must be turned off, not left bleeding into the next prompt",
  );
  assert.equal(render([cell("a", { italic: true }), cell("b")]), `[3ma[23mb${RESET}`);
  assert.equal(render([cell("a", { underline: true }), cell("b")]), `[4ma[24mb${RESET}`);
  assert.equal(render([cell("a", { inverse: true }), cell("b")]), `[7ma[27mb${RESET}`);
});

test("the 16 ANSI palette maps to the short SGR codes", () => {
  assert.equal(render([cell("r", { fg: { t: "idx", i: 1 } })]), `[31mr${RESET}`);
  assert.equal(render([cell("b", { bg: { t: "idx", i: 4 } })]), `[44mb${RESET}`);
  assert.equal(render([cell("R", { fg: { t: "idx", i: 9 } })]), `[91mR${RESET}`);
  assert.equal(render([cell("B", { bg: { t: "idx", i: 12 } })]), `[104mB${RESET}`);
  assert.equal(
    render([cell("x", { fg: { t: "idx", i: 2 }, bg: { t: "idx", i: 6 } })]),
    `[32;46mx${RESET}`,
    "fg and bg share one escape sequence",
  );
});

test("indices above 15 fall back to 256-color, colors above that to truecolor", () => {
  assert.equal(render([cell("x", { fg: { t: "idx", i: 20 } })]), `[38;5;20mx${RESET}`);
  assert.equal(render([cell("x", { bg: { t: "idx", i: 230 } })]), `[48;5;230mx${RESET}`);
  const rgb: CellColorDto = { t: "rgb", r: 12, g: 34, b: 56 };
  assert.equal(render([cell("x", { fg: rgb })]), `[38;2;12;34;56mx${RESET}`);
  assert.equal(render([cell("x", { bg: rgb })]), `[48;2;12;34;56mx${RESET}`);
});

test("trailing blanks are trimmed but meaningful cells are kept", () => {
  // A blank with a background is not empty: it paints the cursor line.
  assert.equal(
    render([cell("o"), cell(" "), cell(" ", { bg: { t: "idx", i: 7 } }), cell(" ")]),
    `o [47m ${RESET}`,
    "the highlight keeps its cell; only the blank after its reset is dropped",
  );
  assert.equal(render([cell("a"), cell(" "), cell(" ")]), `a${RESET}`);
  assert.equal(render([cell(" "), cell("a")]), ` a${RESET}`, "leading blanks stay, columns must line up");
});

test("a fully blank screen paints nothing", () => {
  assert.equal(render([cell(" "), cell(" "), cell(" "), cell(" ")], 2, 2), "\r\n");
  assert.equal(render([], 1, 4), "");
});

test("rows are separated with CRLF and each row resets its own state", () => {
  const cells = [
    cell("a", { bold: true }),
    cell("b"),
    cell("c", { fg: { t: "idx", i: 1 } }),
    cell("d"),
  ];
  assert.deepEqual(render(cells, 2, 2).split("\r\n"), [
    `[1ma[22mb${RESET}`,
    `[31mc[39md${RESET}`,
  ]);
});

test("a snapshot shorter than rows*cols is treated as blanks instead of throwing", () => {
  assert.equal(render([cell("a")], 2, 3), `a${RESET}\r\n`);
});

test("an empty frame is a no-op string, not a stray reset", () => {
  assert.equal(render([], 0, 0), "");
});
