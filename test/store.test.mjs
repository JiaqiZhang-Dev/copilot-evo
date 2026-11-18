import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeGdiBreakdown,
  computeGdiScore,
  exportBundle,
  extractSignals,
  getAssetRelationships,
  getPendingScoreDeltaTotal,
  hasNegativeFeedbackCue,
  hasStrategyCue,
  importBundle,
  initStore,
  isTrivialToolFailure,
  loadStore,
  manageAsset,
  maybeAutoPull,
  normalizeRepoSlug,
  recordAssetOutcome,
  runAssetValidation,
  selectAssets,
  solidifyAsset,
  syncRepoPull,
  syncRepoPush,
  syncScoreDeltasOnly,
} from "../com.github.copilot/extensions/copilot-evo/store.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-evo-test-"));
}

test("initStore seeds starter genes without overwriting existing ones", () => {
  const home = makeTempDir();
  try {
    initStore({ evoHome: home });
    const store1 = loadStore(home);
    assert.ok(store1.genes.some((g) => g.id === "gene-verify-before-claim"));

    const customGenes = store1.genes.map((g) =>
      g.id === "gene-verify-before-claim" ? { ...g, title: "Custom title" } : g
    );
    fs.writeFileSync(path.join(home, "genes.json"), JSON.stringify(customGenes, null, 2));

    initStore({ evoHome: home });
    const store2 = loadStore(home);
    const matched = store2.genes.find((g) => g.id === "gene-verify-before-claim");
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
        kind: "Capsule",
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
        kind: "Capsule",
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
        kind: "Gene",
        title: "Unsafe gene",
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
        kind: "Capsule",
        id: "capsule-npm-e401-azure",
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
    const { genes, capsules } = loadStore(home);
    const ranked = selectAssets({ signals, query: "npm E401", genes, capsules, limit: 2 });
    assert.equal(ranked[0].id, "capsule-npm-e401-azure");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("exportBundle and importBundle stage candidates and promote safely", () => {
  const homeA = makeTempDir();
  const homeB = makeTempDir();
  const bundledDir = makeTempDir();
  const packPath = path.join(homeA, "team.evopack.json");
  try {
    const res = solidifyAsset(
      {
        kind: "Capsule",
        id: "capsule-clean-team",
        title: "Clean shared fix",
        summary: "Use relative workspace paths in scripts.",
        signals: ["path_error"],
        validation: ["node --test"],
        scope: "team",
      },
      { evoHome: homeA, bundledDir }
    );
    assert.match(res.preview, /\[EXP · Fix:capsule-clean-team\]/);

    const exp = exportBundle(homeA, { scope: "team", outputPath: packPath });
    assert.equal(exp.ok, true);
    assert.equal(exp.bundle.capsules.length, 1);

    initStore({ evoHome: homeB, bundledDir });
    const imp = importBundle(homeB, { inputPath: packPath, autoPromote: false });
    assert.equal(imp.ok, true);
    assert.equal(imp.imported, 1);
    assert.equal(imp.promoted, false);

    const promo = manageAsset("promote", "capsule-clean-team", { evoHome: homeB, bundledDir });
    assert.equal(promo.ok, true);
    const storeB = loadStore(homeB);
    assert.ok(storeB.capsules.some((c) => c.id === "capsule-clean-team"));
  } finally {
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test("solidifyAsset enforces English-only text for Genes and Capsules", () => {
  const home = makeTempDir();
  try {
    const rejected = solidifyAsset(
      {
        kind: "Gene",
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
    fs.mkdirSync(path.join(seedDir, "assets", "gep"), { recursive: true });
    fs.writeFileSync(path.join(seedDir, "assets", "gep", "team-genes.json"), "[]\n");
    fs.writeFileSync(path.join(seedDir, "assets", "gep", "team-capsules.json"), "[]\n");
    execFileSync("git", ["-C", seedDir, "add", "."]);
    execFileSync("git", ["-C", seedDir, "commit", "-m", "init"]);
    execFileSync("git", ["-C", seedDir, "push", "-u", "origin", "main"]);

    execFileSync("git", ["clone", bareDir, cloneA]);
    execFileSync("git", ["-C", cloneA, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", cloneA, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["clone", bareDir, cloneB]);

    solidifyAsset(
      {
        kind: "Gene",
        id: "gene-synced-rule",
        title: "Synced team rule",
        summary: "Always validate before pushing.",
        signals: ["git_error"],
        scope: "team",
      },
      { evoHome: homeA, bundledDir }
    );

    const pushRes = await syncRepoPush(homeA, { repoPath: cloneA });
    assert.equal(pushRes.ok, true);
    assert.equal(pushRes.pushed, true);

    initStore({ evoHome: homeB, bundledDir });
    const pullRes = await syncRepoPull(homeB, { repoPath: cloneB });
    assert.equal(pullRes.ok, true);
    assert.equal(pullRes.imported, 1);
    const storeB = loadStore(homeB);
    assert.ok(storeB.genes.some((g) => g.id === "gene-synced-rule"));

    // Both clones record local outcome deltas and merge without losing counts.
    recordAssetOutcome(homeA, ["gene-synced-rule"], "success", "cloneA_hit");
    recordAssetOutcome(homeB, ["gene-synced-rule"], "success", "cloneB_hit");
    await syncRepoPush(homeA, { repoPath: cloneA });
    const pushB2 = await syncRepoPush(homeB, { repoPath: cloneB });
    assert.equal(pushB2.pushed, true);

    await syncRepoPull(homeA, { repoPath: cloneA });
    const afterA = loadStore(homeA).genes.find((g) => g.id === "gene-synced-rule");
    const afterB = loadStore(homeB).genes.find((g) => g.id === "gene-synced-rule");
    assert.equal(afterA.successCount, 3);
    assert.equal(afterB.successCount, 3);
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
    recordAssetOutcome(homeA, ["gene-synced-rule"], "success", "auto_hit");
    assert.equal(getPendingScoreDeltaTotal(homeA), 1);
    const deltaPush = await syncScoreDeltasOnly(homeA, { repoPath: cloneA });
    assert.equal(deltaPush.pushed, true);
    assert.equal(getPendingScoreDeltaTotal(homeA), 0);

    const autoPull = await maybeAutoPull(homeB, { repoPath: cloneB, intervalMs: 60000 });
    assert.equal(autoPull.ran, true);
    const throttledPull = await maybeAutoPull(homeB, { repoPath: cloneB, intervalMs: 60000 });
    assert.equal(throttledPull.ran, false);
    const finalB = loadStore(homeB).genes;
    assert.equal(finalB.find((g) => g.id === "gene-synced-rule").successCount, 4);
    assert.ok(!finalB.some((g) => g.id === "exp-unpushed-draft"));
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
        kind: "Gene",
        id: "gene-global",
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
        kind: "Gene",
        id: "gene-tspec-only",
        title: "TypeSpec repo rule",
        summary: "Applies only in typespec-azure.",
        signals: ["build_error"],
        repoScope: "Azure/typespec-azure",
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );

    const { genes, capsules } = loadStore(home);
    const inOtherRepo = selectAssets({ signals: ["build_error"], repo: "Other/repo", genes, capsules, limit: 5 });
    assert.deepEqual(inOtherRepo.map((a) => a.id), ["gene-global"]);

    const inTspecRepo = selectAssets({ signals: ["build_error"], repo: "Azure/typespec-azure", genes, capsules, limit: 5 });
    assert.equal(inTspecRepo[0].id, "gene-tspec-only");
    assert.ok(inTspecRepo.some((a) => a.id === "gene-global"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test("GDI rank, pin/vote feedback, and Gene/Capsule lineage work together", () => {
  const home = makeTempDir();
  const bundledDir = makeTempDir();
  try {
    solidifyAsset(
      {
        kind: "Gene",
        id: "gene-base-strategy",
        title: "Base strategy",
        summary: "Original approach.",
        signals: ["npm_error"],
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    solidifyAsset(
      {
        kind: "Capsule",
        id: "capsule-derived-fix",
        title: "Derived fix",
        summary: "Concrete verified fix.",
        signals: ["npm_error"],
        geneId: "gene-base-strategy",
        validation: ["npm test"],
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    solidifyAsset(
      {
        kind: "Gene",
        id: "gene-v2-strategy",
        title: "Refined strategy v2",
        summary: "Supersedes base strategy.",
        signals: ["npm_error"],
        parentId: "gene-base-strategy",
        supersedes: "gene-base-strategy",
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );

    const baseInspect = manageAsset("inspect", "gene-base-strategy", { evoHome: home, bundledDir });
    assert.equal(baseInspect.relationships.children.length, 2);
    assert.equal(baseInspect.relationships.supersededBy[0].id, "gene-v2-strategy");
    assert.ok(baseInspect.relationships.sharedSignals.length >= 2);
    assert.equal(baseInspect.asset.successCount, 3);

    const updated = recordAssetOutcome(home, ["capsule-derived-fix"], "success", "test_recovery");
    assert.deepEqual(updated, ["capsule-derived-fix"]);
    assert.equal(hasNegativeFeedbackCue("这个方案不对，还是报错"), true);
    assert.equal(hasNegativeFeedbackCue("Looks good"), false);
    assert.equal(isTrivialToolFailure("create", "File already exists"), true);
    assert.equal(isTrivialToolFailure("edit", "No match found: old_str not found"), true);
    assert.equal(isTrivialToolFailure("powershell", "npm ERR! code E401"), false);

    const beforeScore = computeGdiScore(baseInspect.asset);
    const pinned = manageAsset("pin", "capsule-derived-fix", { evoHome: home, bundledDir });
    assert.ok(pinned.gdiScore > beforeScore);

    const breakdown = computeGdiBreakdown(pinned.asset, loadStore(home).genes.concat(loadStore(home).capsules));
    assert.ok(["S", "A", "B", "C"].includes(breakdown.tier));
    assert.equal(breakdown.winRate, 100);

    const { genes, capsules } = loadStore(home);
    const active = selectAssets({ signals: ["npm_error"], genes, capsules, limit: 5 });
    assert.equal(active[0].id, "capsule-derived-fix");
    assert.ok(!active.some((a) => a.id === "gene-base-strategy"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test("solidifyAsset supports Rule/Fix aliases with exp- prefix", () => {
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
    assert.equal(rule.asset.type, "Gene");
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
        kind: "Capsule",
        id: "capsule-arena-check",
        title: "Arena validation check",
        summary: "Verify safe node command runs in Arena bench.",
        signals: ["test_failure"],
        validation: ['node -e "process.exit(0)"'],
        scope: "team",
      },
      { evoHome: home, bundledDir }
    );
    const res = await runAssetValidation(home, "capsule-arena-check", process.cwd());
    assert.equal(res.ok, true);
    assert.equal(res.passed, true);
    const updated = loadStore(home).capsules.find((c) => c.id === "capsule-arena-check");
    assert.equal(updated.successCount, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});
