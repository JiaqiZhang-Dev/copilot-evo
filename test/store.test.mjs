import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendEvent,
  computeGdiBreakdown,
  computeGdiScore,
  configureSyncRepo,
  detectAuthorName,
  detectSourceLabel,
  exportBundle,
  extractSignals,
  extractToolTargetKey,
  findSimilarAssets,
  getAssetRelationships,
  getPendingScoreDeltaTotal,
  hasCorrectionOrPitfallCue,
  hasNegativeFeedbackCue,
  hasStrategyCue,
  importBundle,
  initStore,
  isActionToolName,
  isPrReviewCue,
  isTrivialToolFailure,
  loadStore,
  manageAsset,
  maybeAutoPull,
  normalizeRepoSlug,
  readRecentEvents,
  recordAssetOutcome,
  recordAssetRecalls,
  runAssetValidation,
  selectAssets,
  setEventSessionContext,
  shouldNudgePostToolUse,
  solidifyAsset,
  syncRepoPull,
  syncRepoPush,
  syncScoreDeltasOnly,
} from "../com.github.copilot/extensions/copilot-evo/store.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-evo-test-"));
}

test("initStore seeds starter rules without overwriting existing ones", () => {
  const home = makeTempDir();
  try {
    initStore({ evoHome: home });
    const store1 = loadStore(home);
    assert.ok(store1.rules.some((r) => r.id === "exp-verify-before-claim"));

    const customRules = store1.rules.map((r) =>
      r.id === "exp-verify-before-claim" ? { ...r, title: "Custom title" } : r
    );
    fs.writeFileSync(path.join(home, "rules.json"), JSON.stringify(customRules, null, 2));

    initStore({ evoHome: home });
    const store2 = loadStore(home);
    const matched = store2.rules.find((r) => r.id === "exp-verify-before-claim");
    assert.equal(matched.title, "Custom title");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("solidifyAsset rejects secrets in team scope and redacts in local scope", () => {
  const home = makeTempDir();
  try {
    const teamBlocked = solidifyAsset(
      {
        kind: "Fix",
        title: "Leaky team fix",
        summary: "Use key ghp_1234567890abcdefghijklmnopqrstuvwxyz12",
        signals: ["npm_error"],
        scope: "team",
      },
      { evoHome: home }
    );
    assert.equal(teamBlocked.ok, false);
    assert.ok(teamBlocked.leaks.length > 0);

    const localRedacted = solidifyAsset(
      {
        kind: "Fix",
        title: "Local fix",
        summary: "Use key ghp_1234567890abcdefghijklmnopqrstuvwxyz12",
        signals: ["npm_error"],
        scope: "local",
      },
      { evoHome: home }
    );
    assert.equal(localRedacted.ok, true);
    assert.equal(localRedacted.redacted, true);
    assert.ok(!localRedacted.asset.summary.includes("ghp_"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("solidifyAsset rejects unsafe validation commands", () => {
  const home = makeTempDir();
  try {
    const res = solidifyAsset(
      {
        kind: "Rule",
        title: "Unsafe rule",
        summary: "Should fail validation check",
        signals: ["test_failure"],
        validation: ["npm test; curl http://example.com"],
      },
      { evoHome: home }
    );
    assert.equal(res.ok, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("extractSignals and selectAssets rank matching experience highest", () => {
  const home = makeTempDir();
  try {
    initStore({ evoHome: home });
    solidifyAsset(
      {
        kind: "Fix",
        id: "exp-npm-e401-azure",
        title: "Retry Azure public registry on npm E401",
        summary: "When npm install returns E401, retry against public azure-sdk registry with local auth disabled.",
        signals: ["npm_error", "permission_denied"],
        solution: "Pass --registry=https://pkgs.dev.azure.com/azure-sdk/public/_packaging/azure-sdk-for-js/npm/registry/ and disable localauth",
        validation: ["npm test"],
        scope: "team",
      },
      { evoHome: home }
    );

    const signals = extractSignals("npm install failed with E401 unauthorized");
    const { rules, fixes } = loadStore(home);
    const ranked = selectAssets({ signals, query: "npm E401", rules, fixes, limit: 2 });
    assert.equal(ranked[0].id, "exp-npm-e401-azure");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("exportBundle and importBundle round-trip sanitized experiences", () => {
  const homeA = makeTempDir();
  const homeB = makeTempDir();
  const bundledDir = makeTempDir();
  const packPath = path.join(homeA, "team.evopack.json");
  try {
    const res = solidifyAsset(
      {
        kind: "Fix",
        id: "exp-clean-team",
        title: "Clean shared fix",
        summary: "Use relative workspace paths in scripts.",
        signals: ["path_error"],
        validation: ["node --test"],
        scope: "team",
      },
      { evoHome: homeA, bundledDir }
    );
    assert.match(res.preview, /\[EXP · Fix:exp-clean-team\]/);

    const exp = exportBundle(homeA, { scope: "team", outputPath: packPath });
    assert.equal(exp.ok, true);
    assert.equal(exp.bundle.fixes.length, 1);

    initStore({ evoHome: homeB, bundledDir });
    const imp = importBundle(homeB, { inputPath: packPath });
    assert.equal(imp.ok, true);
    assert.equal(imp.imported, 1);

    const storeB = loadStore(homeB);
    assert.ok(storeB.fixes.some((f) => f.id === "exp-clean-team"));
  } finally {
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test("solidifyAsset enforces English-only text for Rules and Fixes", () => {
  const home = makeTempDir();
  try {
    const rejected = solidifyAsset(
      {
        kind: "Rule",
        title: "中文经验标题",
        summary: "以后代码实现都要参考现有设计规范",
        signals: ["coding_style"],
        scope: "team",
      },
      { evoHome: home }
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /English/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("hasStrategyCue and extractSignals distinguish rule cues from unrelated prompts", () => {
  assert.equal(hasStrategyCue("以后遇到这个问题都这么处理"), true);
  assert.equal(hasStrategyCue("Always run targeted tests before pushing"), true);
  assert.equal(hasStrategyCue("hello"), false);
  assert.deepEqual(extractSignals("hello world", [], { includePlatform: false }), []);
});

test("syncRepoPush and syncRepoPull round-trip team assets across clones", async () => {
  const root = makeTempDir();
  const bareDir = path.join(root, "remote.git");
  const seedDir = path.join(root, "seed");
  const cloneA = path.join(root, "clone-a");
  const cloneB = path.join(root, "clone-b");
  const homeA = path.join(root, "evo-a");
  const homeB = path.join(root, "evo-b");
  const bundledDir = path.join(root, "empty-bundled");
  fs.mkdirSync(bundledDir, { recursive: true });

  try {
    execFileSync("git", ["init", "--bare", "-b", "main", bareDir]);
    execFileSync("git", ["clone", bareDir, seedDir]);
    execFileSync("git", ["-C", seedDir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", seedDir, "config", "user.email", "test@example.com"]);
    fs.mkdirSync(path.join(seedDir, "assets", "experiences"), { recursive: true });
    fs.writeFileSync(path.join(seedDir, "assets", "experiences", "team-rules.json"), "[]\n");
    fs.writeFileSync(path.join(seedDir, "assets", "experiences", "team-fixes.json"), "[]\n");
    execFileSync("git", ["-C", seedDir, "add", "."]);
    execFileSync("git", ["-C", seedDir, "commit", "-m", "init"]);
    execFileSync("git", ["-C", seedDir, "push", "-u", "origin", "main"]);

    execFileSync("git", ["clone", bareDir, cloneA]);
    execFileSync("git", ["-C", cloneA, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", cloneA, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["clone", bareDir, cloneB]);

    solidifyAsset(
      {
        kind: "Rule",
        id: "exp-synced-rule",
        title: "Synced team rule",
        summary: "Always validate before pushing.",
        signals: ["git_error"],
        scope: "team",
      },
      { evoHome: homeA, bundledDir }
    );
    solidifyAsset(
      {
        kind: "Knowledge",
        id: "exp-synced-knowledge",
        title: "GitHub Actions check_suite quirk",
        summary: "GitHub Actions does not fire check_suite events for github-actions workflow runs.",
        signals: ["github-actions", "check_suite", "workflow_run"],
        strategy: ["Subscribe to both check_suite and workflow_run completed events."],
        scope: "team",
      },
      { evoHome: homeA, bundledDir }
    );

    const pushRes = await syncRepoPush(homeA, { repoPath: cloneA });
    assert.equal(pushRes.ok, true);
    assert.equal(pushRes.pushed, true);
    assert.equal(pushRes.knowledgeCount, 1);

    initStore({ evoHome: homeB, bundledDir });
    const pullRes = await syncRepoPull(homeB, { repoPath: cloneB });
    assert.equal(pullRes.ok, true);
    assert.equal(pullRes.imported, 2);
    const storeB = loadStore(homeB);
    assert.ok(storeB.rules.some((r) => r.id === "exp-synced-rule"));
    assert.ok(storeB.knowledge.some((k) => k.id === "exp-synced-knowledge"));

    // Both clones record local outcome deltas and merge without losing counts.
    recordAssetOutcome(homeA, ["exp-synced-rule"], "success", "cloneA_hit");
    recordAssetOutcome(homeB, ["exp-synced-rule"], "success", "cloneB_hit");
    await syncRepoPush(homeA, { repoPath: cloneA });
    const pushB2 = await syncRepoPush(homeB, { repoPath: cloneB });
    assert.equal(pushB2.pushed, true);

    await syncRepoPull(homeA, { repoPath: cloneA });
    const afterA = loadStore(homeA).rules.find((r) => r.id === "exp-synced-rule");
    const afterB = loadStore(homeB).rules.find((r) => r.id === "exp-synced-rule");
    assert.equal(afterA.successCount, 3);
    assert.equal(afterB.successCount, 3);

    // Deleting a team experience and pushing removes it from the remote team store.
    const delTeam = manageAsset("delete", "exp-synced-knowledge", { evoHome: homeA, bundledDir });
    assert.equal(delTeam.ok, true);
    assert.equal(delTeam.wasTeam, true);
    await syncRepoPull(homeA, { repoPath: cloneA });
    assert.ok(!loadStore(homeA).knowledge.some((k) => k.id === "exp-synced-knowledge"));
    const pushDel = await syncRepoPush(homeA, { repoPath: cloneA });
    assert.equal(pushDel.pushed, true);
    assert.equal(pushDel.knowledgeCount, 0);
    await syncRepoPull(homeA, { repoPath: cloneA });
    assert.ok(!loadStore(homeA).knowledge.some((k) => k.id === "exp-synced-knowledge"));
    assert.equal(afterA.pendingSuccessDelta, undefined);

    // syncScoreDeltasOnly pushes score deltas for existing remote items without pushing new unconfirmed entries.
    solidifyAsset(
      {
        kind: "Rule",
        id: "exp-unpushed-draft",
        title: "Unpushed local rule",
        summary: "Should stay local and not be pushed by score delta sync.",
        signals: ["style"],
        scope: "local",
      },
      { evoHome: homeA, bundledDir }
    );
    recordAssetOutcome(homeA, ["exp-synced-rule"], "success", "auto_hit");
    assert.equal(getPendingScoreDeltaTotal(homeA), 1);
    const deltaPush = await syncScoreDeltasOnly(homeA, { repoPath: cloneA });
    assert.equal(deltaPush.pushed, true);
    assert.equal(getPendingScoreDeltaTotal(homeA), 0);

    const autoPull = await maybeAutoPull(homeB, { repoPath: cloneB, intervalMs: 0 });
    assert.equal(autoPull.ran, true);
    const throttledPull = await maybeAutoPull(homeB, { repoPath: cloneB, intervalMs: 60000 });
    assert.equal(throttledPull.ran, false);
    const finalB = loadStore(homeB).rules;
    assert.equal(finalB.find((r) => r.id === "exp-synced-rule").successCount, 4);
    assert.ok(!finalB.some((r) => r.id === "exp-unpushed-draft"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repoScope filters repo-specific assets and boosts exact repo matches", () => {
  const home = makeTempDir();
  const bundledDir = makeTempDir();
  try {
    assert.equal(normalizeRepoSlug("https://user:secret@github.com/Azure/typespec-azure.git"), "Azure/typespec-azure");
    assert.equal(normalizeRepoSlug("git@github.com:JiaqiZhang-Dev/copilot-evo.git"), "JiaqiZhang-Dev/copilot-evo");
    assert.equal(normalizeRepoSlug("*"), "*");

    solidifyAsset(
      {
        kind: "Rule",
        id: "exp-global",
        title: "Global rule",
        summary: "Applies everywhere.",
        signals: ["build_error"],
        repoScope: "*",
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    solidifyAsset(
      {
        kind: "Rule",
        id: "exp-tspec-only",
        title: "TypeSpec repo rule",
        summary: "Applies only in typespec-azure.",
        signals: ["build_error"],
        repoScope: "Azure/typespec-azure",
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );

    const { rules, fixes } = loadStore(home);
    const inOtherRepo = selectAssets({ signals: ["build_error"], repo: "Other/repo", rules, fixes, limit: 5 });
    assert.deepEqual(inOtherRepo.map((a) => a.id), ["exp-global"]);

    const inTspecRepo = selectAssets({ signals: ["build_error"], repo: "Azure/typespec-azure", rules, fixes, limit: 5 });
    assert.equal(inTspecRepo[0].id, "exp-tspec-only");
    assert.ok(inTspecRepo.some((a) => a.id === "exp-global"));

    assert.equal(isPrReviewCue("review PR #17611"), true);
    const reviewSignals = extractSignals("review PR #17611", [], { includePlatform: false });
    assert.ok(reviewSignals.includes("pr_review"));
    const reviewMatched = selectAssets({
      signals: reviewSignals,
      query: "review PR #17611",
      repo: "Azure/typespec-azure",
      isReview: true,
      rules,
      fixes,
      limit: 5,
    });
    assert.ok(reviewMatched.some((a) => a.id === "exp-tspec-only"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test("score rank, pin/vote feedback, and Rule/Fix lineage work together", () => {
  const home = makeTempDir();
  const bundledDir = makeTempDir();
  try {
    solidifyAsset(
      {
        kind: "Rule",
        id: "exp-base-strategy",
        title: "Base strategy",
        summary: "Original approach.",
        signals: ["npm_error"],
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    solidifyAsset(
      {
        kind: "Fix",
        id: "exp-derived-fix",
        title: "Derived fix",
        summary: "Concrete verified fix.",
        signals: ["npm_error"],
        ruleId: "exp-base-strategy",
        validation: ["npm test"],
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    solidifyAsset(
      {
        kind: "Rule",
        id: "exp-v2-strategy",
        title: "Refined strategy v2",
        summary: "Supersedes base strategy.",
        signals: ["npm_error"],
        parentId: "exp-base-strategy",
        supersedes: "exp-base-strategy",
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );

    const baseInspect = manageAsset("inspect", "exp-base-strategy", { evoHome: home, bundledDir });
    assert.equal(baseInspect.relationships.children.length, 2);
    assert.equal(baseInspect.relationships.supersededBy[0].id, "exp-v2-strategy");
    assert.ok(baseInspect.relationships.sharedSignals.length >= 2);
    assert.equal(baseInspect.asset.successCount, 3);

    const updated = recordAssetOutcome(home, ["exp-derived-fix"], "success", "test_recovery");
    assert.deepEqual(updated, ["exp-derived-fix"]);
    assert.equal(hasNegativeFeedbackCue("这个方案不对，还是报错"), true);
    assert.equal(hasNegativeFeedbackCue("Looks good"), false);
    assert.equal(hasStrategyCue("we should bump version across envs"), true);
    assert.equal(hasCorrectionOrPitfallCue("the commit can not show in comment"), true);
    assert.equal(hasCorrectionOrPitfallCue("这里看不到链接"), true);
    assert.equal(hasCorrectionOrPitfallCue("Looks good, thanks"), false);
    assert.equal(extractToolTargetKey("view", { path: "README.md" }), "");
    assert.equal(extractToolTargetKey("edit", { path: "C:\\repo\\README.md" }), "file:c:\\repo\\readme.md");
    assert.equal(extractToolTargetKey("reply_to_review_thread", { thread_id: "PRRT_123" }), "pr_thread:PRRT_123");
    assert.equal(extractToolTargetKey("powershell", { command: "gh api repos/o/r/pulls/comments/4610709428 -X PATCH" }), "gh_comment:4610709428");
    assert.equal(isActionToolName("view"), false);
    assert.equal(isActionToolName("edit"), true);
    assert.equal(isActionToolName("powershell", { command: "gh pr diff 17611" }), false);
    assert.equal(isActionToolName("powershell", { command: "npm test" }), true);
    assert.equal(shouldNudgePostToolUse({ turnIndex: 1, turnActionTools: 0 }), false);
    assert.equal(shouldNudgePostToolUse({ turnIndex: 1, turnActionTools: 1 }), true);
    assert.equal(shouldNudgePostToolUse({ turnIndex: 1, turnActionTools: 1, solidifiedTurn: 1 }), false);
    assert.equal(shouldNudgePostToolUse({ turnIndex: 1, turnActionTools: 1, lastNudgeTurn: 1 }), false);
    const beforeRecallSuccess = loadStore(home).fixes.find((f) => f.id === "exp-derived-fix").successCount;
    recordAssetRecalls(home, ["exp-derived-fix", "exp-base-strategy"]);
    const afterRecall = loadStore(home).fixes.find((f) => f.id === "exp-derived-fix");
    assert.equal(afterRecall.recallCount, 1);
    assert.equal(afterRecall.successCount, beforeRecallSuccess);
    assert.equal(isTrivialToolFailure("create", "File already exists"), true);
    assert.equal(isTrivialToolFailure("edit", "No match found: old_str not found"), true);
    assert.equal(isTrivialToolFailure("powershell", "npm ERR! code E401"), false);

    const beforeScore = computeGdiScore(baseInspect.asset);
    const pinned = manageAsset("pin", "exp-derived-fix", { evoHome: home, bundledDir });
    assert.ok(pinned.gdiScore > beforeScore);

    const breakdown = computeGdiBreakdown(pinned.asset, loadStore(home).rules.concat(loadStore(home).fixes));
    assert.ok(["S", "A", "B", "C"].includes(breakdown.tier));
    assert.equal(breakdown.winRate, 100);

    const { rules, fixes } = loadStore(home);
    const active = selectAssets({ signals: ["npm_error"], rules, fixes, limit: 5 });
    assert.equal(active[0].id, "exp-derived-fix");
    assert.ok(!active.some((a) => a.id === "exp-base-strategy"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test("solidifyAsset supports Rule/Fix with exp- prefix", () => {
  const home = makeTempDir();
  const bundledDir = makeTempDir();
  try {
    const rule = solidifyAsset(
      {
        kind: "Rule",
        title: "Prefer concise comments",
        summary: "Keep code comments short and clear across repositories.",
        signals: ["code_style"],
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    assert.equal(rule.ok, true);
    assert.ok(rule.asset.id.startsWith("exp-"));
    assert.equal(rule.asset.type, "Rule");
    assert.equal(detectSourceLabel(undefined), "chat");
    assert.ok(typeof detectAuthorName(process.cwd()) === "string");

    const ghDir = makeTempDir();
    const prevGhDir = process.env.GH_CONFIG_DIR;
    const prevEvoAuthor = process.env.COPILOT_EVO_AUTHOR;
    try {
      delete process.env.COPILOT_EVO_AUTHOR;
      process.env.GH_CONFIG_DIR = ghDir;
      fs.writeFileSync(path.join(ghDir, "hosts.yml"), "github.com:\n    user: OctoDev\n", "utf8");
      assert.equal(detectAuthorName(process.cwd()), "OctoDev");
    } finally {
      if (prevGhDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = prevGhDir;
      if (prevEvoAuthor === undefined) delete process.env.COPILOT_EVO_AUTHOR;
      else process.env.COPILOT_EVO_AUTHOR = prevEvoAuthor;
      fs.rmSync(ghDir, { recursive: true, force: true });
    }

    // Updating an experience with an ID longer than 48 chars must update in place, not truncate.
    const longId = "exp-very-long-experience-identifier-exceeding-forty-eight-chars-1234";
    solidifyAsset(
      { kind: "Rule", id: longId, title: "Long ID rule", summary: "Initial summary text.", signals: ["test"], scope: "local" },
      { evoHome: home, bundledDir }
    );
    const updated = solidifyAsset(
      { kind: "Rule", id: longId, title: "Long ID rule", summary: "Refined summary text.", signals: ["test"], scope: "local" },
      { evoHome: home, bundledDir }
    );
    assert.equal(updated.asset.id, longId);
    assert.equal(loadStore(home).rules.filter((r) => r.id === longId).length, 1);

    solidifyAsset(
      {
        kind: "Rule",
        id: "exp-bare-sha-github",
        title: "Leave commit SHAs unwrapped in GitHub comments",
        summary: "GitHub treats backtick-wrapped commit SHAs as inline code instead of auto-linking them.",
        signals: ["github", "pr_comment", "commit_sha"],
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    const nearDup = solidifyAsset(
      {
        kind: "Rule",
        title: "Do not wrap commit SHA in backticks in GitHub comments",
        summary: "GitHub fails to link commit SHAs wrapped in backticks in PR comments.",
        signals: ["github", "pr_comment", "commit_sha"],
        scope: "local",
      },
      { evoHome: home, bundledDir }
    );
    assert.equal(nearDup.ok, false);
    assert.equal(nearDup.duplicateDetected, true);
    assert.equal(nearDup.similarCandidates[0].id, "exp-bare-sha-github");

    const distinctRule = solidifyAsset(
      {
        kind: "Rule",
        title: "Redeploy server when tenant prompts change",
        summary: "ChatService loads tenant prompts at startup so server needs redeployment.",
        signals: ["qa_bot", "deploy_dev", "tenant_prompts"],
        scope: "local",
      },
      { evoHome: home, bundledDir }
    );
    assert.equal(distinctRule.ok, true);
    assert.equal(findSimilarAssets({ type: "Rule", title: "Unrelated topic", signals: ["other"] }, loadStore(home).rules).length, 0);

    // Knowledge category: fair quality score & in-place reclassification across category files.
    const kn = solidifyAsset(
      {
        kind: "Knowledge",
        id: "exp-knowledge-reclassify",
        title: "ChatService loads tenant prompts at startup",
        summary: "Server injects prompts/tenants/*.md as [skill] on each request, so tenant prompt edits require redeploying server.",
        signals: ["qa_bot", "tenant_prompts"],
        strategy: ["Redeploy both chat_agent and server when tenant prompts change."],
        references: ["https://github.com/Azure/azure-sdk-tools/pull/17496"],
        scope: "local",
      },
      { evoHome: home, bundledDir }
    );
    assert.equal(kn.ok, true);
    assert.equal(kn.asset.type, "Knowledge");
    assert.equal(kn.asset.references[0].label, "Azure/azure-sdk-tools#17496 (PR)");
    const knQuality = computeGdiBreakdown(kn.asset, loadStore(home).knowledge);
    assert.equal(knQuality.quality, 100);
    assert.ok(loadStore(home).knowledge.some((k) => k.id === "exp-knowledge-reclassify"));

    const badLink = solidifyAsset(
      {
        kind: "Knowledge",
        title: "Unsafe reference test",
        summary: "Verify unsafe localhost links are rejected cleanly.",
        signals: ["security", "links"],
        references: ["http://127.0.0.1:8080/secret"],
        scope: "local",
      },
      { evoHome: home, bundledDir }
    );
    assert.equal(badLink.ok, false);

    const movedToRule = solidifyAsset(
      {
        kind: "Rule",
        id: "exp-knowledge-reclassify",
        title: "Redeploy server when tenant prompts change",
        summary: "Server injects prompts/tenants/*.md as [skill] on each request, so tenant prompt edits require redeploying server.",
        signals: ["qa_bot", "tenant_prompts"],
        strategy: ["Check prompts/tenants changes.", "Redeploy both chat_agent and server."],
        scope: "local",
      },
      { evoHome: home, bundledDir }
    );
    assert.equal(movedToRule.ok, true);
    assert.equal(movedToRule.asset.successCount, 2);
    assert.ok(!loadStore(home).knowledge.some((k) => k.id === "exp-knowledge-reclassify"));
    assert.ok(loadStore(home).rules.some((r) => r.id === "exp-knowledge-reclassify"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test("runAssetValidation executes whitelisted command and updates outcome", async () => {
  const home = makeTempDir();
  const bundledDir = makeTempDir();
  try {
    solidifyAsset(
      {
        kind: "Fix",
        id: "exp-arena-check",
        title: "Validation check",
        summary: "Verify safe node command runs in validation bench.",
        signals: ["test_failure"],
        validation: ['node -e "process.exit(0)"'],
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    const res = await runAssetValidation(home, "exp-arena-check", process.cwd());
    assert.equal(res.ok, true);
    assert.equal(res.passed, true);
    const updated = loadStore(home).fixes.find((f) => f.id === "exp-arena-check");
    assert.equal(updated.successCount, 2);

    setEventSessionContext(() => ({
      sessionId: "623e92ec-test-session",
      sessionName: "Test Session",
      repo: "JiaqiZhang-Dev/copilot-evo",
      project: "JiaqiZhang-Dev/copilot-evo",
    }));
    try {
      recordAssetOutcome(home, ["exp-arena-check"], "success", "session_tag_check");
      const evs = readRecentEvents(home, 5);
      assert.equal(evs[0].sessionId, "623e92ec-test-session");
      assert.equal(evs[0].sessionName, "Test Session");
      assert.equal(evs[0].repo, "JiaqiZhang-Dev/copilot-evo");
    } finally {
      setEventSessionContext(null);
    }

    for (let i = 0; i < 6; i++) {
      appendEvent(home, { event: "recall", seq: i }, { maxEvents: 4, forcePruneCheck: true });
    }
    const capped = readRecentEvents(home, 20);
    assert.equal(capped.length, 4);
    assert.equal(capped[0].seq, 5);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test("initStore defaults to local-only without bundling team experiences and configureSyncRepo connects/disconnects", async () => {
  const home = makeTempDir();
  const remoteBare = makeTempDir();
  const seedClone = makeTempDir();
  try {
    execFileSync("git", ["init", "--bare", "-b", "main", remoteBare], { stdio: "ignore" });
    execFileSync("git", ["clone", remoteBare, seedClone], { stdio: "ignore" });
    execFileSync("git", ["-C", seedClone, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", seedClone, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    fs.mkdirSync(path.join(seedClone, "assets", "experiences"), { recursive: true });
    fs.writeFileSync(
      path.join(seedClone, "assets", "experiences", "team-rules.json"),
      JSON.stringify([
        {
          id: "exp-external-team-rule",
          kind: "Rule",
          title: "External team rule",
          summary: "Pulled only from configured private team repo.",
          signals: ["deploy"],
          scope: "team",
          successCount: 2,
          failureCount: 0,
        },
      ], null, 2)
    );
    execFileSync("git", ["-C", seedClone, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", seedClone, "commit", "-m", "Seed team repo"], { stdio: "ignore" });
    execFileSync("git", ["-C", seedClone, "push", "-u", "origin", "main"], { stdio: "ignore" });

    initStore({ evoHome: home });
    const initialStore = loadStore(home);
    assert.equal(initialStore.config.syncRepo, "");
    assert.equal(initialStore.rules.filter((r) => r.scope === "team").length, 0);

    const connectRes = await configureSyncRepo(home, { repo: remoteBare });
    assert.equal(connectRes.ok, true);
    assert.equal(connectRes.imported, 1);

    const syncedStore = loadStore(home);
    assert.ok(syncedStore.rules.some((r) => r.id === "exp-external-team-rule"));
    assert.equal(syncedStore.config.syncRepo, remoteBare);

    const failRes = await configureSyncRepo(home, { repo: "file:///nonexistent/copilot-evo-missing.git" });
    assert.equal(failRes.ok, false);
    assert.equal(loadStore(home).config.syncRepo, remoteBare);

    const disconnectRes = await configureSyncRepo(home, { repo: "" });
    assert.equal(disconnectRes.ok, true);
    assert.equal(disconnectRes.disconnected, true);
    assert.equal(disconnectRes.removedTeamCount, 1);
    const afterDisconnect = loadStore(home);
    assert.equal(afterDisconnect.config.syncRepo, "");
    assert.equal(afterDisconnect.config.lastAutoPullAt, "");
    assert.equal(afterDisconnect.rules.some((r) => r.id === "exp-external-team-rule"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(remoteBare, { recursive: true, force: true });
    fs.rmSync(seedClone, { recursive: true, force: true });
  }
});
