/**
 * Office chat lines: a CLI redraws its TUI many times a second, so most rows
 * are chrome. The panel shows one line per agent; it must be a real one, and
 * team-bus traffic must be recognisable. Nothing is rewritten, only filtered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifySpeechLine, isSpeechNoise, pickSpeechLine } from "@/lib/speech";

test("TUI chrome is never a spoken line", () => {
  for (const noise of [
    "",
    " ",
    "────────────",
    "⏵⏵ auto mode on (shift+tab to cycle)",
    "◐ medium · /effort",
    "❯",
    "  ⎿  Running…",
    "35% context left",
    "· Worked for 3s",
    'Try "how do I log an error?"',
    '❯ Try "write a test for <filepath>"',
    "› Ask Codex to do anything",
    "? for shortcuts",
    "Loading",
    "/opt/yuppycode",
    "Welcome to Codex",
    "▝▝   ▝▝   /opt/yuppycode",
    ">_ OpenAI Codex (v0.166.0)",
    "▝▜██████▀  API Usage Billing",
    "← for agents · ? for shortcuts",
    "Qwen3.8 Flash Next (Evren) default",
    "esc to interrupt",
  ]) {
    assert.equal(isSpeechNoise(noise), true, JSON.stringify(noise));
  }
});

test("real prose survives the filter", () => {
  assert.equal(isSpeechNoise("README dosyasına iki satır not ekledim."), false);
  assert.equal(isSpeechNoise("Tests pass, no regressions found"), false);
});

test("newest meaningful line wins, skipping trailing chrome", () => {
  const screen = [
    "Refactoring the parser now.",
    "Bash(npm test)",
    "──────────",
    "⏵⏵ auto mode on (shift+tab to cycle)",
    "❯",
  ];
  const picked = pickSpeechLine(screen);
  assert.ok(picked);
  assert.equal(picked.text, "Bash(npm test)");
  assert.equal(picked.kind, "command");
});

test("an all-chrome screen yields nothing instead of a fake line", () => {
  assert.equal(pickSpeechLine(["──────", "⏵⏵ auto mode", "❯", ""]), null);
});

test("team-bus traffic is classified as team, not prose", () => {
  const send = classifySpeechLine('yuppy_send(to: "*", message: "status ok")');
  assert.equal(send.kind, "team");
  const inbox = classifySpeechLine("[#2] from anon-123 (to everyone): PARITY-OK");
  assert.equal(inbox.kind, "team");
});

test("a plain sentence is a message; a bare token is output", () => {
  assert.equal(classifySpeechLine("I finished the migration and pushed it").kind, "message");
  assert.equal(classifySpeechLine("0.42ms").kind, "output");
});
