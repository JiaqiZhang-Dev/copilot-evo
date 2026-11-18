import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exportBundle,
  extractSignals,
  importBundle,
  initStore,
  loadStore,
  manageAsset,
  selectAssets,
  solidifyAsset,
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
