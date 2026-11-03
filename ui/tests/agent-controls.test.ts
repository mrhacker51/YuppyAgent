/**
 * Agent controls: the model catalog and character picks are presentation +
 * task-spec inputs. These tests pin the contract that a model override is what
 * reaches `TaskSpecDto.model`, and that a character pick resolves deterministically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MODELS, modelForAgent, modelLabel, modelCtx } from "@/lib/agentModels";
import { accentFor, CHARACTERS, characterFor, isKnownSprite, spriteBaseFor } from "@/lib/characters";
import { buildTaskSpecs, defaultReceiverIds } from "@/lib/composer";

test("model catalog is the real gateway set with context windows", () => {
  const ids = MODELS.map((m) => m.id);
  assert.ok(ids.includes("deepseek-v4.1-flash"));
  assert.ok(ids.includes("mimo-v2.6-pro"));
  for (const m of MODELS) assert.ok(m.ctx >= 262_144, `${m.id} ctx`);
  assert.equal(modelCtx("deepseek-v4.1-flash"), 1_048_576);
  assert.equal(modelLabel("deepseek-v4.1-flash"), "DeepSeek V4.1 Flash");
  assert.equal(modelLabel(null), "CLI varsayılanı");
});

test("operator override beats the department role default", () => {
  assert.equal(modelForAgent("claude-code", { "claude-code": "mimo-v2.6-pro" }, "glm-5.3"), "mimo-v2.6-pro");
  assert.equal(modelForAgent("claude-code", {}, "glm-5.3"), "glm-5.3");
  assert.equal(modelForAgent("codex", {}, null), null);
});

test("the chosen model lands in the task spec the bridge receives", () => {
  const specs = buildTaskSpecs(
    "fix the build",
    [{ id: "claude-code", model: "mimo-v2.6-pro" }, { id: "codex" }],
    { id: "dev", roles: [{ cli: "codex", model: "glm-5.3" }] },
    true,
  );
  assert.equal(specs[0].model, "mimo-v2.6-pro", "override wins");
  assert.equal(specs[1].model, "glm-5.3", "role default fills the gap");
  assert.equal(specs[0].isolation, "worktree");
});

test("receivers default to every detected CLI", () => {
  assert.deepEqual(
    defaultReceiverIds([
      { id: "claude-code", available: true },
      { id: "codex", available: true },
      { id: "gemini", available: false },
    ]),
    ["claude-code", "codex"],
    "unavailable CLIs cannot own a seat",
  );
});

test("one prompt fans out with Claude leading as primary", () => {
  // Caller order is deliberate: the lead must still lead the batch.
  const specs = buildTaskSpecs(
    "fix the build",
    [{ id: "codex" }, { id: "claude-code" }, { id: "gemini" }],
    undefined,
    true,
  );
  assert.deepEqual(
    specs.map((s) => [s.cli, s.role]),
    [
      ["claude-code", "primary"],
      ["codex", "parallel"],
      ["gemini", "parallel"],
    ],
  );
  assert.equal(new Set(specs.map((s) => s.prompt)).size, 1, "one prompt, fanned out");
});

test("a single receiver is the primary and keeps its plain title", () => {
  const [spec] = buildTaskSpecs("ship it", [{ id: "codex" }], undefined, false);
  assert.equal(spec.cli, "codex");
  assert.equal(spec.role, "primary");
  assert.equal(spec.title, "ship it");
  assert.equal(spec.isolation, "shared");
});

test("every character maps to a shipped sprite and picks are stable", () => {
  assert.ok(CHARACTERS.length >= 8);
  const ids = new Set(CHARACTERS.map((c) => c.id));
  assert.equal(ids.size, CHARACTERS.length, "unique ids");
  const sprites = new Set(CHARACTERS.map((c) => c.sprite));
  assert.equal(sprites.size, CHARACTERS.length, "one body per character");
  for (const c of CHARACTERS) {
    assert.ok(isKnownSprite(c.sprite), `${c.id} → ${c.sprite} has art`);
    assert.match(c.accent, /^#[0-9a-f]{6}$/i);
  }
  // explicit choice wins, and an unknown agent id still resolves
  const picked = characterFor("claude-code", { "claude-code": "security" });
  assert.equal(picked.id, "security");
  assert.equal(spriteBaseFor("claude-code", { "claude-code": "security" }), "security-audit-1");
  const a = characterFor("some-agent");
  const b = characterFor("some-agent");
  assert.equal(a.id, b.id, "deterministic fallback");
});

test("without a pick, Claude and Codex keep their own bodies", () => {
  assert.equal(spriteBaseFor("claude-code"), "Claude-1");
  assert.equal(spriteBaseFor("codex"), "dev-1");
  // and the accent follows the same identity
  assert.equal(accentFor("claude-code"), "#e08a5c");
  assert.equal(accentFor("codex"), "#7dd3a0");
});
