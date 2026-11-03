// Seat dialog detection against screens captured from the real CLIs.
import test from "node:test";
import assert from "node:assert/strict";
import { seatShowsDialog } from "@/lib/term";

test("Codex 0.166 folder-trust dialog is a dialog (capital T, new footer)", () => {
  const screen = [
    "  Folder access",
    "  /tmp/work/plain",
    "  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.",
    "› 1. Trust and continue",
    "  2. Back to Agent Command Center",
    "  enter continue · esc back",
  ].join("\n");
  assert.equal(seatShowsDialog(screen), true);
});

test("a clipped Codex trust dialog is still caught by its footer", () => {
  assert.equal(seatShowsDialog("  enter continue · esc back"), true);
});

test("Codex Agent Command Center list has no composer either", () => {
  assert.equal(seatShowsDialog("  ? help  esc back  ↑/↓ move  enter open  n new"), true);
});

test("Claude Code trust dialog is still a dialog", () => {
  assert.equal(
    seatShowsDialog(" Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n Enter to confirm · Esc to cancel"),
    true,
  );
});

test("ready composers are not dialogs", () => {
  assert.equal(
    seatShowsDialog("  >_ OpenAI Codex (v0.166.0)\n› Ask Codex to do anything\n  Qwen3.8 Flash Next (Evren) medium · /opt/yuppycode\n  ← for agents · ? for shortcuts"),
    false,
  );
  assert.equal(seatShowsDialog("╭──╮\n│ > │\n╰──╯\n  ? for shortcuts"), false);
});
