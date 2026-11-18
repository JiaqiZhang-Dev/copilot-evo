import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEvoCanvasServer } from "../com.github.copilot/extensions/copilot-evo/canvas-server.mjs";
import { initStore, solidifyAsset } from "../com.github.copilot/extensions/copilot-evo/store.mjs";

test("evo canvas server serves UI, state snapshot, and enforces token on mutations", async () => {
  const evoHome = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-evo-canvas-"));
  const server = createEvoCanvasServer({ evoHome });

  try {
    initStore({ evoHome });
    solidifyAsset(
      {
        kind: "Gene",
        id: "gene-canvas-preview",
        title: "Previewable gene",
        summary: "Verify canvas snapshot exposes stored genes.",
        signals: ["preview"],
        scope: "team",
      },
      { evoHome }
    );

    const openResult = await server.openInstance({
      instanceId: "test-panel-1",
      input: { tab: "assets", filter: "team" },
    });
    assert.ok(openResult.url.startsWith("http://127.0.0.1:"));

    const baseUrl = new URL(openResult.url).origin;
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /Copilot Evo/);

    const stateRes = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.ok(state.genes.some((g) => g.id === "gene-canvas-preview"));
    assert.equal(state.viewState.filter, "team");

    const unauthDelete = await fetch(`${baseUrl}/api/assets/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "gene-canvas-preview" }),
    });
    assert.equal(unauthDelete.status, 403);

    const cfgRes = await fetch(`${baseUrl}/api/config`);
    const { canvasToken } = await cfgRes.json();

    const authDelete = await fetch(`${baseUrl}/api/assets/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ id: "gene-canvas-preview" }),
    });
    assert.equal(authDelete.status, 200);
    const delBody = await authDelete.json();
    assert.equal(delBody.ok, true);

    solidifyAsset(
      {
        kind: "Capsule",
        id: "capsule-local-promote",
        title: "Local capsule to promote",
        summary: "Verify promote-team upgrades clean local assets.",
        signals: ["test_failure"],
        scope: "local",
      },
      { evoHome }
    );
    const promoteTeam = await fetch(`${baseUrl}/api/assets/promote-team`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ id: "capsule-local-promote" }),
    });
    assert.equal(promoteTeam.status, 200);
    const promoteBody = await promoteTeam.json();
    assert.equal(promoteBody.asset.scope, "team");

    const feedbackRes = await fetch(`${baseUrl}/api/assets/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ id: "capsule-local-promote", action: "pin" }),
    });
    assert.equal(feedbackRes.status, 200);
    const feedbackBody = await feedbackRes.json();
    assert.equal(feedbackBody.asset.pinned, true);
    assert.ok(feedbackBody.gdiScore > 0);
  } finally {
    await server.closeInstance({ instanceId: "test-panel-1" });
    fs.rmSync(evoHome, { recursive: true, force: true });
  }
});
