// Scripted content for the fake agents used by the README demo recording.
// Every scenario is one pane: what the agent "was asked", what it does while
// working, how it wraps up and, optionally, the approval it stops on.
//
// Event kinds (see fake-agent.mjs):
//   { say }                         assistant text, streamed
//   { tool, arg, result, ms, diff } tool call; diff rows are [kind, line, text]
//   { run, ms, result }             shell command shown as "Running…" first
//   { todos: [[done, text], ...] }  todo list
//   { think: ms, verb }             spinner only

const d = (kind, line, text) => [kind, line, text];

export const ACCOUNTS = {
  personal: "default",
  work: "5d0c2a3e-8f41-4b7a-9d2e-6a1f0c3b7e95",
};

export const SCENARIOS = {
  // ── checkout-api · Claude (Work) — seeded, two panes ───────────────────
  "api-retry": {
    agent: "claude",
    resumeId: "7c1e4b2a-0d9f-4e63-8a51-2b7f9c0d4e11",
    title: "Retry with backoff in the SQS consumer",
    prompt: "Add retry with exponential backoff to the SQS consumer",
    steps: [
      { todos: [[true, "Read the SQS consumer"], [false, "Add retry with backoff"], [false, "Cover it with tests"]] },
      { tool: "Read", arg: "src/queue/consumer.ts", result: "142 lines", ms: 700 },
      { say: "The handler runs once and drops the message on any error. I'll wrap it in a retry with jittered backoff." },
      {
        tool: "Update", arg: "src/queue/consumer.ts", ms: 900, touch: "src/queue/consumer.ts",
        result: "Updated src/queue/consumer.ts with 9 additions and 2 removals",
        diff: [
          d("ctx", 41, "for (const msg of batch) {"),
          d("del", 42, "  await handler(msg)"),
          d("add", 42, "  await withRetry(() => handler(msg), {"),
          d("add", 43, "    retries: 5,"),
          d("add", 44, "    baseDelayMs: 200,"),
          d("add", 45, "    jitter: true,"),
          d("add", 46, "  })"),
        ],
      },
    ],
    // Seeded agents run for a while before the recording starts: their loops
    // are long and slow so the scrollback on screen never visibly repeats.
    loop: [
      { think: 3200, verb: "Clauding" },
      { tool: "Read", arg: "src/queue/retry.ts", result: "58 lines", ms: 900 },
      { say: "withRetry already exists but never caps the delay. Adding a 30s ceiling." },
      {
        tool: "Update", arg: "src/queue/retry.ts", ms: 1100, touch: "src/queue/retry.ts",
        result: "Updated src/queue/retry.ts with 3 additions and 1 removal",
        diff: [
          d("del", 21, "  const delay = base * 2 ** attempt"),
          d("add", 21, "  const delay = Math.min(base * 2 ** attempt, 30_000)"),
        ],
      },
      { think: 2800, verb: "Percolating" },
      { run: "npm test -- retry", ms: 2600, result: ["PASS  src/queue/retry.test.ts", "Tests: 14 passed, 14 total"] },
      { think: 3400, verb: "Noodling" },
      { tool: "Read", arg: "src/queue/metrics.ts", result: "37 lines", ms: 900 },
      { say: "Emitting a retry counter so the dashboard can alert on retry storms." },
      {
        tool: "Update", arg: "src/queue/metrics.ts", ms: 1000, touch: "src/queue/metrics.ts",
        result: "Updated src/queue/metrics.ts with 4 additions",
        diff: [d("add", 12, "export const retries = counter('sqs_retries_total')")],
      },
      { think: 3000, verb: "Clauding" },
      { tool: "Read", arg: "test/queue/consumer.test.ts", result: "88 lines", ms: 900 },
      { say: "Adding a test where the handler fails twice and then succeeds." },
      { think: 3600, verb: "Percolating" },
    ],
    finish: [
      { say: "Done. Failed messages now retry 5× with capped, jittered backoff." },
    ],
  },
  "api-tests": {
    agent: "claude",
    resumeId: "a4f09d6e-3b28-4c7e-9f15-8e2d6b1a0c37",
    title: "Contract tests for the payments webhook",
    prompt: "Write contract tests for the payments webhook",
    steps: [
      { tool: "Read", arg: "src/webhooks/payments.ts", result: "96 lines", ms: 600 },
      { tool: "Read", arg: "openapi/payments.yaml", result: "211 lines", ms: 600 },
      { say: "Covering the three event types and the signature check." },
      {
        tool: "Write", arg: "test/webhooks/payments.contract.test.ts", ms: 1000,
        result: "Created test/webhooks/payments.contract.test.ts (64 lines)",
        diff: [
          d("add", 1, "describe('POST /webhooks/payments', () => {"),
          d("add", 2, "  it('rejects a bad signature', async () => {"),
          d("add", 3, "    const res = await post(event, { sig: 'x' })"),
          d("add", 4, "    expect(res.status).toBe(401)"),
        ],
      },
    ],
    loop: [
      { think: 3000, verb: "Clauding" },
      { run: "npm test -- payments.contract", ms: 2800, result: ["PASS  test/webhooks/payments.contract.test.ts", "Tests: 9 passed, 9 total"] },
      { think: 3200, verb: "Noodling" },
      { say: "Adding a case for duplicated deliveries." },
      {
        tool: "Update", arg: "test/webhooks/payments.contract.test.ts", ms: 1100,
        result: "Updated test/webhooks/payments.contract.test.ts with 11 additions",
        diff: [
          d("add", 58, "  it('is idempotent on redelivery', async () => {"),
          d("add", 59, "    await post(event); await post(event)"),
          d("add", 60, "    expect(await ledger.count()).toBe(1)"),
        ],
      },
      { think: 3400, verb: "Percolating" },
      { tool: "Read", arg: "src/webhooks/signature.ts", result: "44 lines", ms: 900 },
      { say: "The signature check compares strings directly. Switching to a timing-safe compare." },
      {
        tool: "Update", arg: "src/webhooks/signature.ts", ms: 1000,
        result: "Updated src/webhooks/signature.ts with 2 additions and 1 removal",
        diff: [
          d("del", 17, "  return sig === expected"),
          d("add", 17, "  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected))"),
        ],
      },
      { think: 3600, verb: "Clauding" },
    ],
    finish: [{ say: "Done. 10 contract tests, all green." }],
  },

  // ── landing-page · Claude (Personal) — seeded ───────────────────────────
  "web-hero": {
    agent: "claude",
    resumeId: "3e8b7d10-5c4a-4f29-b6e3-9d0a1c7f2b58",
    title: "Hero section with the new brand colors",
    prompt: "Rebuild the hero section with the new brand colors",
    steps: [
      { tool: "Read", arg: "src/components/Hero.tsx", result: "88 lines", ms: 600 },
      { tool: "Read", arg: "src/styles/tokens.css", result: "54 lines", ms: 500 },
      { say: "Swapping the hard-coded blues for the brand tokens and tightening the headline." },
      {
        tool: "Update", arg: "src/components/Hero.tsx", ms: 900, touch: "src/components/Hero.tsx",
        result: "Updated src/components/Hero.tsx with 6 additions and 4 removals",
        diff: [
          d("del", 12, "  <h1 className=\"text-blue-600 text-5xl\">"),
          d("add", 12, "  <h1 className=\"text-brand-500 text-6xl\">"),
          d("del", 13, "    Build faster"),
          d("add", 13, "    Ship in minutes, not weeks"),
        ],
      },
    ],
    loop: [
      { think: 3200, verb: "Moseying" },
      { run: "npm run build", ms: 2600, result: ["✓ built in 2.41s"] },
      { think: 3000, verb: "Clauding" },
      { tool: "Read", arg: "src/components/CTA.tsx", result: "41 lines", ms: 900 },
      { say: "Matching the call-to-action button to the new palette." },
      {
        tool: "Update", arg: "src/components/CTA.tsx", ms: 1000, touch: "src/components/CTA.tsx",
        result: "Updated src/components/CTA.tsx with 2 additions and 2 removals",
        diff: [
          d("del", 4, "  <button className=\"bg-blue-600\">Start</button>"),
          d("add", 4, "  <button className=\"bg-brand-500 text-ink\">Start free</button>"),
        ],
      },
      { think: 3400, verb: "Percolating" },
      { tool: "Read", arg: "src/pages/index.tsx", result: "63 lines", ms: 900 },
      { say: "Lazy-loading the hero illustration to keep LCP under a second." },
      { think: 3600, verb: "Noodling" },
    ],
    finish: [{ say: "Done. The hero now uses the brand palette." }],
  },

  // ── mobile-app · Codex — seeded ─────────────────────────────────────────
  "mobile-tokens": {
    agent: "codex",
    tick: 700,
    resumeId: "9b2c4e71-6a0d-4f8b-a3e5-1c7d9f2b6e04",
    title: "Settings screen on the new design tokens",
    prompt: "Migrate the settings screen to the new design tokens",
    ctx: 92,
    steps: [
      { say: "I'll locate the settings screen and the token definitions first." },
      { tool: "Explored", arg: "Search SettingsScreen in src", result: "Read SettingsScreen.tsx, tokens.ts", ms: 900 },
      {
        tool: "Edited", arg: "src/screens/SettingsScreen.tsx (+24 -31)", ms: 900,
        diff: [
          d("del", 18, "  color: '#1f6feb',"),
          d("add", 18, "  color: tokens.color.accent,"),
          d("del", 19, "  padding: 12,"),
          d("add", 19, "  padding: tokens.space.md,"),
        ],
      },
    ],
    loop: [
      { think: 1600, verb: "Working" },
      { run: "npm test -- settings", ms: 1700, result: ["✓ 37 tests passed"] },
      { say: "Updating the snapshot for the dark theme variant." },
      { think: 1400, verb: "Working" },
    ],
    finish: [{ say: "Settings now reads every color and spacing from tokens." }],
  },

  // ── infra · Cursor Agent — seeded ───────────────────────────────────────
  "infra-dlq": {
    agent: "cursor",
    tick: 700,
    resumeId: "c6d1a8f3-2e7b-4c90-8d4a-5f3b0e9c1a26",
    title: "Dead-letter queue for the payments stack",
    prompt: "Add a dead-letter queue to the payments stack",
    steps: [
      { tool: "Read", arg: "modules/queue/main.tf", ms: 700 },
      { say: "Adding a DLQ with a redrive policy after 5 receives." },
      {
        tool: "Edited", arg: "modules/queue/main.tf  +18 -2", ms: 900,
        diff: [
          d("add", 24, "resource \"aws_sqs_queue\" \"payments_dlq\" {"),
          d("add", 25, "  name = \"payments-dlq\""),
          d("add", 26, "}"),
        ],
      },
    ],
    loop: [
      { think: 1500, verb: "Generating" },
      { run: "terraform plan", ms: 1800, result: ["Plan: 2 to add, 1 to change, 0 to destroy."] },
      { think: 1400, verb: "Generating" },
    ],
    finish: [{ say: "The DLQ and redrive policy are ready to apply." }],
  },

  // ── new session during the recording · Claude (Personal, worktree) ─────
  // These are on screen the longest, so their loops are long and varied and
  // paced like a real agent: a tool call every couple of seconds.
  "wt-refunds": {
    agent: "claude",
    title: "Partial refunds endpoint",
    prompt: "Add a partial refunds endpoint",
    typePrompt: true,
    ctx: 34,
    steps: [
      { todos: [[false, "Accept an amount on POST /refunds"], [false, "Validate it against the balance"], [false, "Cover it with tests"]] },
      { tool: "Read", arg: "src/routes/refunds.ts", result: "73 lines", ms: 800 },
      { say: "Refunds are all-or-nothing today. Adding an optional amount, validated against what is left on the charge." },
      {
        tool: "Update", arg: "src/routes/refunds.ts", ms: 1100, touch: "src/routes/refunds.ts",
        result: "Updated src/routes/refunds.ts with 8 additions and 1 removal",
        diff: [
          d("del", 19, "  await gateway.refund(charge.id)"),
          d("add", 19, "  const amount = parseAmount(body.amount, charge)"),
          d("add", 20, "  await gateway.refund(charge.id, { amount })"),
        ],
      },
    ],
    loop: [
      { think: 2400, verb: "Clauding" },
      { tool: "Read", arg: "src/routes/charges.ts", result: "120 lines", ms: 800 },
      { say: "Rejecting amounts above the remaining balance with a 422." },
      {
        tool: "Update", arg: "src/routes/charges.ts", ms: 1000, touch: "src/routes/charges.ts",
        result: "Updated src/routes/charges.ts with 5 additions",
        diff: [
          d("add", 44, "export const remaining = (c) =>"),
          d("add", 45, "  c.amount - sum(c.refunds.map((r) => r.amount))"),
        ],
      },
      { think: 2200, verb: "Percolating" },
      { run: "npm test -- refunds", ms: 2600, result: ["PASS  src/routes/refunds.test.ts", "Tests: 11 passed, 11 total"] },
      { think: 2600, verb: "Noodling" },
      { tool: "Read", arg: "src/routes/refunds.test.ts", result: "96 lines", ms: 800 },
      { say: "Adding cases for zero, negative and over-balance amounts." },
      { think: 3000, verb: "Clauding" },
    ],
    finish: [{ say: "Done. Partial refunds are validated against the balance." }],
  },
  "wt-tests": {
    agent: "claude",
    title: "Load test for the refunds endpoint",
    prompt: "Write a load test for the refunds endpoint",
    typePrompt: true,
    steps: [
      { tool: "Read", arg: "src/routes/refunds.ts", result: "81 lines", ms: 700 },
      {
        tool: "Write", arg: "load/refunds.k6.js", ms: 1100,
        result: "Created load/refunds.k6.js (38 lines)",
        diff: [
          d("add", 1, "export const options = { vus: 50, duration: '30s' }"),
          d("add", 2, "export default () => post('/refunds', body)"),
        ],
      },
    ],
    loop: [
      { think: 2000, verb: "Noodling" },
      { run: "k6 run load/refunds.k6.js", ms: 3200, result: ["http_req_duration p(95)=84ms", "checks: 100.00%"] },
      { think: 2600, verb: "Clauding" },
      { say: "Raising to 200 VUs to find where p95 crosses 250 ms." },
      { think: 3000, verb: "Percolating" },
    ],
    finish: [{ say: "Done. p95 is 84 ms at 50 VUs and 212 ms at 200, no errors." }],
  },
  "wt-ledger": {
    agent: "claude",
    title: "Refunds in the ledger export",
    prompt: "Include refunds in the ledger export",
    typePrompt: true,
    steps: [
      { tool: "Read", arg: "src/ledger/export.ts", result: "64 lines", ms: 800 },
      { say: "The export only reads charges. Refunds should land as negative entries." },
    ],
    loop: [
      { think: 2200, verb: "Clauding" },
      { tool: "Read", arg: "src/ledger/entry.ts", result: "29 lines", ms: 800 },
      { think: 2600, verb: "Percolating" },
      { tool: "Read", arg: "src/ledger/csv.ts", result: "41 lines", ms: 800 },
      { think: 3000, verb: "Noodling" },
    ],
    approval: {
      file: "src/ledger/export.ts",
      lines: [
        d("add", 31, "for (const r of refunds) {"),
        d("add", 32, "  rows.push(entry(r, -r.amount))"),
        d("add", 33, "}"),
      ],
    },
    afterApproval: [
      {
        tool: "Update", arg: "src/ledger/export.ts", ms: 900, touch: "src/ledger/export.ts",
        result: "Updated src/ledger/export.ts with 3 additions",
      },
      { think: 1600, verb: "Clauding" },
      { run: "npm test -- ledger", ms: 2400, result: ["PASS  src/ledger/export.test.ts", "Tests: 6 passed, 6 total"] },
    ],
    finish: [{ say: "Done. Refunds show up as negative ledger rows." }],
  },
};

export function scenarioByResumeId(id) {
  if (!id) return null;
  const needle = id.toLowerCase();
  for (const [key, scenario] of Object.entries(SCENARIOS)) {
    if (scenario.resumeId === needle) return key;
  }
  return null;
}
