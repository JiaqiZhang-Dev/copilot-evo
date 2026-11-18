import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  exportBundle,
  extractSignals,
  hasStrategyCue,
  importBundle,
  initStore,
  loadStore,
  manageAsset,
  selectAssets,
  solidifyAsset,
  syncRepoPull,
  syncRepoPush,
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
  const packPath = path.join(homeA, "team.evopack.json");
  try {
    solidifyAsset(
      {
        kind: "Capsule",
        id: "capsule-clean-team",
        title: "Clean shared fix",
        summary: "Use relative workspace paths in scripts.",
        signals: ["path_error"],
        validation: ["node --test"],
        scope: "team",
      },
      { evoHome: homeA }
    );

    const exp = exportBundle(homeA, { scope: "team", outputPath: packPath });
    assert.equal(exp.ok, true);
    assert.equal(exp.bundle.capsules.length, 1);

    const imp = importBundle(homeB, { inputPath: packPath, autoPromote: false });
    assert.equal(imp.ok, true);
    assert.equal(imp.imported, 1);
    assert.equal(imp.promoted, false);

    const promo = manageAsset("promote", "capsule-clean-team", { evoHome: homeB });
    assert.equal(promo.ok, true);
    const storeB = loadStore(homeB);
    assert.ok(storeB.capsules.some((c) => c.id === "capsule-clean-team"));
  } finally {
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
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
      { evoHome: homeA }
    );

    const pushRes = await syncRepoPush(homeA, { repoPath: cloneA });
    assert.equal(pushRes.ok, true);
    assert.equal(pushRes.pushed, true);

    initStore({ evoHome: homeB });
    const pullRes = await syncRepoPull(homeB, { repoPath: cloneB });
    assert.equal(pullRes.ok, true);
    assert.equal(pullRes.imported, 1);
    const storeB = loadStore(homeB);
    assert.ok(storeB.genes.some((g) => g.id === "gene-synced-rule"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
