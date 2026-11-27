import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEvoCanvasServer } from "../com.github.copilot/extensions/copilot-evo/canvas-server.mjs";
import { addPendingCapture, initStore, solidifyAsset } from "../com.github.copilot/extensions/copilot-evo/store.mjs";

test("evo canvas server serves UI, state snapshot, and enforces token on mutations", async () => {
  const evoHome = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-evo-canvas-"));
  const refineCalls = [];
  const graduateCalls = [];
  const extractCalls = [];
  const server = createEvoCanvasServer({
    evoHome,
    onRefineRequest: async (payload) => {
      refineCalls.push(payload);
    },
    onGraduateRequest: async (payload) => {
      graduateCalls.push(payload);
    },
    onExtractCaptureRequest: async (payload) => {
      extractCalls.push(payload);
    },
  });

  try {
    initStore({ evoHome });
    solidifyAsset(
      {
        kind: "Rule",
        id: "exp-canvas-preview",
        title: "Previewable rule",
        summary: "Verify canvas snapshot exposes stored rules.",
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
    const html = await htmlRes.text();
    assert.match(html, /Copilot Evo/);
    assert.match(html, /data-tab="contributors" hidden/);
    assert.match(html, /btn-team-repo/);
    assert.match(html, /repo-modal/);
    assert.match(html, /repo-modal-link/);
    assert.match(html, /data-kind="Knowledge"/);
    assert.match(html, /chip-repo-only/);
    assert.match(html, /sort-select/);
    assert.match(html, /loading-overlay/);
    assert.doesNotMatch(html, /data-tab="arena"/);
    assert.doesNotMatch(html, /id="rel-toolbar"/);

    const stateRes = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.ok(state.rules.some((r) => r.id === "exp-canvas-preview"));
    assert.ok(Array.isArray(state.knowledge));
    assert.equal(state.viewState.filter, "team");

    const unauthDelete = await fetch(`${baseUrl}/api/assets/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "exp-canvas-preview" }),
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
      body: JSON.stringify({ id: "exp-canvas-preview" }),
    });
    assert.equal(authDelete.status, 200);
    const delBody = await authDelete.json();
    assert.equal(delBody.ok, true);

    solidifyAsset(
      {
        kind: "Fix",
        id: "exp-local-promote",
        title: "Local fix to promote",
        summary: "Verify promote-team upgrades clean local experiences.",
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
      body: JSON.stringify({ id: "exp-local-promote", push: false }),
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
      body: JSON.stringify({ id: "exp-local-promote", action: "pin" }),
    });
    assert.equal(feedbackRes.status, 200);
    const feedbackBody = await feedbackRes.json();
    assert.equal(feedbackBody.asset.pinned, true);
    assert.ok(feedbackBody.gdiScore > 0);

    const refineRes = await fetch(`${baseUrl}/api/assets/refine`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ id: "exp-local-promote", feedback: "Keep scope strict" }),
    });
    assert.equal(refineRes.status, 200);
    assert.equal(refineCalls.length, 1);
    assert.equal(refineCalls[0].feedback, "Keep scope strict");

    const invalidCfgRes = await fetch(`${baseUrl}/api/sync/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ repo: "not a valid repo!!!" }),
    });
    assert.equal(invalidCfgRes.status, 400);
    const invalidCfgBody = await invalidCfgRes.json();
    assert.equal(invalidCfgBody.ok, false);

    const gradPreviewRes = await fetch(`${baseUrl}/api/assets/graduate-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ id: "exp-local-promote", targetType: "copilot-instructions" }),
    });
    assert.equal(gradPreviewRes.status, 200);
    const gradPreviewBody = await gradPreviewRes.json();
    assert.equal(gradPreviewBody.ok, true);
    assert.equal(gradPreviewBody.preview, true);
    assert.equal(gradPreviewBody.targetPath, ".github/copilot-instructions.md");

    const gradReqRes = await fetch(`${baseUrl}/api/assets/graduate-request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ id: "exp-local-promote" }),
    });
    assert.equal(gradReqRes.status, 200);
    assert.equal(graduateCalls.length, 1);
    assert.equal(graduateCalls[0].asset.id, "exp-local-promote");

    const cap = addPendingCapture(evoHome, {
      sessionId: "sess-canvas",
      turnIndex: 3,
      reason: "cross-turn revision",
      prompt: "keep comments concise",
    });
    const extractRes = await fetch(`${baseUrl}/api/captures/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ id: cap.id }),
    });
    assert.equal(extractRes.status, 200);
    assert.equal(extractCalls.length, 1);
    assert.equal(extractCalls[0].capture.id, cap.id);

    const disconnectCfgRes = await fetch(`${baseUrl}/api/sync/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify({ repo: "" }),
    });
    assert.equal(disconnectCfgRes.status, 200);
    const disconnectCfgBody = await disconnectCfgRes.json();
    assert.equal(disconnectCfgBody.ok, true);
    assert.equal(disconnectCfgBody.disconnected, true);
  } finally {
    await server.closeInstance({ instanceId: "test-panel-1" });
    fs.rmSync(evoHome, { recursive: true, force: true });
  }
});
