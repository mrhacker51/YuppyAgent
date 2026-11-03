/**
 * Lead-plan extraction tests: the fenced block can be reflowed by any PTY,
 * must never partially parse, and only a strictly valid plan reaches the
 * approval gate. Nothing here may fake a plan.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractMissionPlan, validateMissionPlan, MAX_PLAN_SLICES } from "@/lib/missionPlan";
import { cellsToJoinedText } from "@/lib/term";

const PLAN = (overrides: object = {}) =>
  JSON.stringify({
    goal: "README ve build script'ini düzelt",
    slices: [
      { cli: "claude-code", role: "software-development", title: "docs", prompt: "README'yi güncelle", isolation: "worktree" },
      { cli: "codex", role: "testing", title: "tests", prompt: "npm test'i çalıştır ve kırılanı düzelt", isolation: "worktree" },
    ],
    ...overrides,
  });

test("extracts a plan from a clean fenced block", () => {
  const text = `düşünce...\n\`\`\`yuppy-plan\n${PLAN()}\n\`\`\`\nson söz`;
  const out = extractMissionPlan(text);
  assert.ok(out && "plan" in out);
  assert.equal(out.plan.slices.length, 2);
  assert.equal(out.plan.slices[0].cli, "claude-code");
});

test("a PTY reflow (arbitrary newlines) does not break the plan", () => {
  const wrapped = PLAN().replace(/,/g, ",\n"); // every comma on its own line
  const text = `\`\`\`yuppy-plan\n${wrapped}\n\`\`\``;
  const out = extractMissionPlan(text);
  assert.ok(out && "plan" in out);
  assert.equal(out.plan.slices[1].cli, "codex");
});

test("no fence yet returns null (still streaming) — never a guess", () => {
  assert.equal(extractMissionPlan("lead düşünüyor…"), null);
  assert.equal(extractMissionPlan("```yuppy-plan\n{\"goal\":"), null);
});

test("malformed JSON is an explicit error, not silent approval", () => {
  const out = extractMissionPlan("```yuppy-plan\n{goal: 1}\n```");
  assert.deepEqual(out, { error: "plan bloğundaki JSON çözülemedi" });
});

test("unknown cli is rejected", () => {
  const out = extractMissionPlan(`\`\`\`yuppy-plan\n${PLAN({ slices: [{ cli: "gemini", title: "x", prompt: "y" }] })}\n\`\`\``);
  assert.ok(out && "error" in out && out.error.includes("gemini"));
});

test("too many slices is rejected", () => {
  const slices = Array.from({ length: MAX_PLAN_SLICES + 1 }, (_, i) => ({
    cli: "claude-code", title: `t${i}`, prompt: `görev ${i} — yeterince uzun prompt`,
  }));
  const out = validateMissionPlan({ goal: "çok dilimli plan", slices });
  assert.ok("error" in out && out.error.includes("dilim"));
});

test("missing goal is rejected", () => {
  const out = validateMissionPlan({ goal: "", slices: [{ cli: "codex", title: "t", prompt: "prompt yeter" }] });
  assert.deepEqual(out, { error: "goal eksik" });
});

test("shared isolation is honoured when the lead asks for it", () => {
  const out = validateMissionPlan({
    goal: "paylaşımlı deney",
    slices: [{ cli: "codex", title: "tek dosya", prompt: "tek dosyalık değişiklik promptu", isolation: "shared" }],
  });
  assert.ok("plan" in out && out.plan.slices[0].isolation === "shared");
});

test("rendered block header (● yuppy-plan, no backticks) is extracted", () => {
  const text = `yanıt:\n● yuppy-plan\n  ${PLAN()}\n\n❯`;
  const out = extractMissionPlan(text);
  assert.ok(out && "plan" in out);
  assert.equal(out.plan.slices.length, 2);
});

test("last marker wins over an earlier echo of the brief", () => {
  const echo = `\`\`\`yuppy-plan\n${PLAN({ goal: "eski taslak" })}\n\`\`\``;
  const real = `● yuppy-plan\n${PLAN({ goal: "gerçek hedef" })}`;
  const out = extractMissionPlan(`${echo}\n...\n${real}`);
  assert.ok(out && "plan" in out);
  assert.equal(out.plan.goal, "gerçek hedef");
});

test("hard-wrapped long strings survive (no whitespace mangling needed)", () => {
  const longPrompt = "a".repeat(200);
  const json = JSON.stringify({
    goal: "uzun promptlu dilim",
    slices: [{ cli: "codex", title: "uzun", prompt: longPrompt, isolation: "worktree" }],
  });
  // simulate a 40-col terminal: build real cells, render with the same
  // wrap-aware join the store uses for the transcript
  const text = `● yuppy-plan\n${json}`;
  const cols = 40;
  const rows = Math.ceil(text.length / cols);
  const cells = [...text].map((ch) => ({ ch, fg: 0, bg: 0, bold: false, underline: false, inverse: false }));
  while (cells.length < rows * cols) cells.push({ ch: " ", fg: 0, bg: 0, bold: false, underline: false, inverse: false });
  const joined = cellsToJoinedText(cells as never, rows, cols);
  const out = extractMissionPlan(joined);
  assert.ok(out && "plan" in out);
  assert.equal(out.plan.slices[0].prompt.length, 200);
});

test("the brief's template echo is skipped, the real plan wins", () => {
  const template = `{"goal":"<tek cümle hedef>","slices":[{"cli":"claude-code|codex","role":"backend","title":"<kısa ad>","prompt":"<kendi kendine yetebilen görev>","isolation":"worktree"}]}`;
  const echo = `yuppy-plan\n${template}\n`;
  // no real plan yet → no error, no plan (gate stays shut, nothing to approve)
  assert.equal(extractMissionPlan(echo), null);
  // real plan printed after the echo
  const out = extractMissionPlan(`${echo}\n● yuppy-plan\n${PLAN({ goal: "gerçek iş" })}`);
  assert.ok(out && "plan" in out);
  assert.equal(out.plan.goal, "gerçek iş");
});

test("raw newlines inside strings are repaired to spaces, keys survive", () => {
  const broken = `{"goal":"README dosyasına iki\n  satırlık not","slices":[{"cli":"codex","title":"README\n  notu","prompt":"dosya\n  sonuna ekle ve\n  testleri koş","isolation":"worktree"}]}`;
  const out = extractMissionPlan(`● yuppy-plan\n${broken}`);
  assert.ok(out && "plan" in out);
  assert.equal(out.plan.slices[0].title, "README notu");
  assert.ok(out.plan.slices[0].prompt.includes("dosya sonuna ekle"));
});
