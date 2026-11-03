//! Frontend-neutral snapshot types for an emulated terminal screen.
//!
//! These types deliberately restate (rather than re-export) what vt100
//! gives us, so the vt100 dependency can be bumped or swapped by editing
//! only this module. The TUI maps [`Color`] onto its own theme palette.

/// Terminal cell color. `Indexed` uses the standard xterm 256-color
/// palette; `Rgb` is a truecolor value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    /// Terminal default foreground/background.
    Default,
    /// Indexed palette entry (0..=255).
    Indexed(u8),
    /// 24-bit color.
    Rgb(u8, u8, u8),
}

/// One character cell of the screen at snapshot time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenCell {
    /// Cell text: normally one char; wide glyphs (CJK) carry the full
    /// grapheme here while the following cell is a continuation.
    pub ch: String,
    pub fg: Color,
    pub bg: Color,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    /// True for cells consumed as the tail of a wide glyph. Renderers
    /// should skip them (the glyph lives in the preceding cell).
    pub wide_continuation: bool,
}

impl ScreenCell {
    /// Whether the cell carries anything to draw.
    pub fn is_blank(&self) -> bool {
        self.ch.is_empty() || self.ch == " "
    }
}

/// An immutable copy of the visible terminal grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenSnapshot {
    pub rows: u16,
    pub cols: u16,
    /// Cursor position (row, col), clamped to the grid.
    pub cursor: (u16, u16),
    pub cursor_visible: bool,
    pub title: String,
    /// Row-major `rows * cols` cells.
    pub cells: Vec<ScreenCell>,
    /// Monotonic counter bumped each time new PTY output was parsed.
    /// Renderers can skip redraw when it has not changed.
    pub generation: u64,
}

impl ScreenSnapshot {
    /// Cell lookup with bounds guard.
    pub fn cell(&self, row: u16, col: u16) -> Option<&ScreenCell> {
        if row < self.rows && col < self.cols {
            Some(&self.cells[usize::from(row) * usize::from(self.cols) + usize::from(col)])
        } else {
            None
        }
    }

    /// Plain text of a screen row (wide-continuation cells collapsed).
    pub fn row_text(&self, row: u16) -> String {
        let mut s = String::new();
        if row >= self.rows {
            return s;
        }
        let start = usize::from(row) * usize::from(self.cols);
        for c in &self.cells[start..start + usize::from(self.cols)] {
            if c.wide_continuation {
                continue;
            }
            s.push_str(&c.ch);
        }
        s
    }
}

pub(crate) fn map_color(c: vt100::Color) -> Color {
    match c {
        vt100::Color::Default => Color::Default,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}
