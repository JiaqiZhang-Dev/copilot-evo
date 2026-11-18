let state = null;
let canvasToken = "";
let activeTab = "assets";
let activeFilter = "all";
let activeKind = "all";
let repoFilter = "all";
let contribMode = "author";
let contribScope = "all";
let eventFilter = "all";
let eventSessionFilter = "";
let relMode = "all";
let relShowStandalone = false;
let selectedSignalHub = "";
let searchQuery = "";
let selectedId = "";
let selectedContribKey = "";
let pendingDeleteId = "";
let sharingId = "";
let justSharedId = "";
let toastTimer = null;

const el = (id) => document.getElementById(id);

function setLoadingOverlay(visible, text = "Working...") {
  const overlay = el("loading-overlay");
  const label = el("loading-text");
  if (!overlay) return;
  if (label) label.textContent = text;
  overlay.classList.toggle("hidden", !visible);
}

function showToast(title, subtitle = "") {
  const toast = el("toast");
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.className = "toast";
  toast.innerHTML = `
    <span class="toast-spark" aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path d="M8 1.5l1.5 4.2 4.2 1.5-4.2 1.5L8 13l-1.5-4.3-4.2-1.5 4.2-1.5L8 1.5Z" fill="currentColor"/>
      </svg>
    </span>
    <div>
      <div class="toast-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="toast-sub">${escapeHtml(subtitle)}</div>` : ""}
    </div>
  `;
  toast.onclick = () => {
    toast.className = "toast hidden";
  };
  toastTimer = setTimeout(() => {
    toast.className = "toast hidden";
  }, 3600);
}

function showBanner(message, isError = false) {
  const banner = el("banner");
  if (!message) {
    banner.className = "banner hidden";
    banner.textContent = "";
    return;
  }
  banner.className = isError ? "banner error" : "banner";
  banner.textContent = message;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getAllAssets() {
  if (!state) return [];
  return [...(state.rules || []), ...(state.fixes || [])].sort((a, b) => {
    const scoreDiff = (b.gdiScore || 0) - (a.gdiScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const reuseDiff = (b.successCount || 0) - (a.successCount || 0);
    if (reuseDiff !== 0) return reuseDiff;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

function getFilteredAssets() {
  const q = searchQuery.trim().toLowerCase();
  const curRepo = (state?.currentRepo || "").toLowerCase();
  const isLocalTab = activeTab === "local";
  return getAllAssets().filter((item) => {
    const scope = item.scope || "local";
    if (isLocalTab) {
      if (scope !== "local") return false;
    } else {
      if (scope === "local") return false;
      if (activeFilter !== "all" && scope !== activeFilter) return false;
    }
    if (activeKind !== "all" && item.type !== activeKind) return false;
    if (repoFilter === "matching") {
      const r = (item.repoScope || "*").toLowerCase();
      if (r !== "*" && (!curRepo || r !== curRepo)) return false;
    } else if (repoFilter === "only") {
      const r = (item.repoScope || "*").toLowerCase();
      if (r === "*" || (curRepo && r !== curRepo)) return false;
    }
    if (!q) return true;
    const text = `${item.id} ${item.title} ${item.summary} ${item.solution || ""} ${item.repoScope || ""} ${(item.signals || []).join(" ")}`.toLowerCase();
    return text.includes(q);
  });
}

function getFilteredEvents() {
  let events = state?.events || [];
  if (eventFilter === "signals") {
    events = events.filter((ev) => ev.event === "tool_failure");
  } else if (eventFilter === "evolution") {
    events = events.filter((ev) => ev.event !== "tool_failure");
  }
  const targetSession =
    eventSessionFilter === "current" ? state?.currentSession?.sessionId || "" : eventSessionFilter;
  if (targetSession) {
    events = events.filter((ev) => ev.sessionId === targetSession);
  }
  return events;
}

function formatLocalTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function displayTypeWord(type) {
  return type === "Fix" ? "Fix" : type === "Rule" ? "Rule" : type || "Experience";
}

function formatEventMeta(ev) {
  switch (ev.event) {
    case "solidify":
      return { label: "Solidified", cls: "ev-ok", desc: `${displayTypeWord(ev.assetType)}: ${ev.assetId || ""}` };
    case "sync_push":
      return {
        label: "Team Push",
        cls: "ev-ok",
        desc: `Synced ${ev.rulesCount ?? ev.genesCount ?? 0} Rules · ${ev.fixesCount ?? ev.capsulesCount ?? 0} Fixes`,
      };
    case "sync_pull":
      return { label: "Team Pull", cls: "ev-ok", desc: `Imported ${ev.imported || 0} team experience(s)` };
    case "sync_scores":
      return { label: "Auto Score Sync", cls: "ev-ok", desc: "Synced team experience score deltas" };
    case "promote_team":
      return { label: "Shared to Team", cls: "ev-ok", desc: `${displayTypeWord(ev.assetType)}: ${ev.assetId || ""}` };
    case "auto_success":
    case "feedback_upvote":
      return {
        label: "Auto +Score",
        cls: "ev-ok",
        desc: `${(ev.assetIds || [ev.assetId]).filter(Boolean).join(", ")} (${ev.reason || "verified"})`,
      };
    case "auto_failure":
    case "feedback_downvote":
      return {
        label: "Auto -Score",
        cls: "ev-warn",
        desc: `${(ev.assetIds || [ev.assetId]).filter(Boolean).join(", ")} (${ev.reason || "feedback"})`,
      };
    case "validation_pass":
      return { label: "Validation Pass", cls: "ev-ok", desc: `Validation passed for ${ev.assetId || ""}` };
    case "validation_fail":
      return { label: "Validation Fail", cls: "ev-warn", desc: `Validation failed for ${ev.assetId || ""}` };
    case "delete":
      return { label: "Deleted", cls: "", desc: `Removed ${ev.assetId || ""}` };
    case "tool_failure":
      return { label: "Signal Captured", cls: "ev-warn", desc: `Tool ${ev.toolName || "unknown"} failed (observed for learning)` };
    default:
      return { label: ev.event || "Event", cls: "", desc: ev.assetId || ev.toolName || "" };
  }
}

function kindLabel(type) {
  return type === "Fix" ? "FIX" : "RULE";
}

function renderScoreRing(score) {
  const val = Math.max(0, Math.min(100, Number(score || 0)));
  const r = 17;
  const circ = 2 * Math.PI * r;
  const dash = ((val / 100) * circ).toFixed(1);
  return `
    <svg class="score-ring" viewBox="0 0 44 44" aria-label="Score ${val}">
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="rgba(9, 105, 218, 0.15)" stroke-width="3.5" />
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--accent)" stroke-width="3.5"
        stroke-linecap="round" stroke-dasharray="${dash} ${circ.toFixed(1)}" transform="rotate(-90 22 22)" />
      <text x="22" y="25.5" text-anchor="middle" fill="var(--accent)" font-size="11" font-weight="700" font-family="Consolas, monospace">${Math.round(val)}</text>
    </svg>`;
}

function renderDetail(item) {
  const pane = el("detail-pane");
  if (!item) {
    pane.innerHTML = `<div class="empty">Select an Experience to inspect its signals, steps, and validation evidence.</div>`;
    return;
  }

  const signals = (item.signals || []).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
  const strategy = (item.strategy || []).length
    ? `<div class="section-label">Steps</div><ol class="steps">${item.strategy
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join("")}</ol>`
    : "";
  const solution = item.solution
    ? `<div class="section-label">Verified Fix</div><p class="detail-box">${escapeHtml(item.solution)}</p>`
    : "";
  const guardrail = item.guardrail?.reason
    ? `<div class="section-label">Guardrail</div><p class="detail-box">${escapeHtml(item.guardrail.reason)}</p>`
    : "";
  const validation = (item.validation || []).length
    ? `<div class="section-label">Validation Commands</div><p class="detail-box code-box">${escapeHtml(item.validation.join("\n"))}</p>`
    : "";

  const isSharing = sharingId === item.id;
  const hasVal = Array.isArray(item.validation) && item.validation.length > 0;
  const validateBtn = hasVal
    ? `<button class="btn" data-validate="${escapeHtml(item.id)}" type="button">Run Validation</button>`
    : "";
  const promoteTeamBtn =
    item.scope === "local"
      ? `<button class="btn btn-primary" data-promote-team="${escapeHtml(item.id)}" type="button" ${isSharing ? "disabled" : ""} title="Sanitize and share with your team">${isSharing ? "Sharing..." : "Share with Team"}</button>`
      : "";
  const copyBtn = `<button class="btn" data-copy="${escapeHtml(item.id)}" type="button">Copy JSON</button>`;
  const closeBtn = `<button class="btn btn-close" data-close-detail type="button" title="Close detail drawer">✕</button>`;

  const rel = item.relationships || {};
  const relLinks = [];
  if (rel.rule) relLinks.push({ role: "Rule", item: rel.rule });
  if (rel.parent) relLinks.push({ role: "Parent", item: rel.parent });
  if (rel.supersedes) relLinks.push({ role: "Supersedes", item: rel.supersedes });
  for (const child of rel.children || []) relLinks.push({ role: child.type === "Fix" ? "Fix" : "Derived", item: child });
  for (const rep of rel.supersededBy || []) relLinks.push({ role: "Replaced by", item: rep });
  for (const shared of rel.sharedSignals || []) {
    if (!relLinks.some((l) => l.item.id === shared.id)) {
      relLinks.push({ role: `Shared (${shared.overlap.join(", ")})`, item: shared });
    }
  }
  const lineageHtml = `<div class="section-label">Relationships</div>${
    relLinks.length
      ? `<div class="link-list">${relLinks
          .map(
            (l) =>
              `<button class="link-pill" data-jump="${escapeHtml(l.item.id)}" type="button">${escapeHtml(l.role)}: ${escapeHtml(l.item.id)}</button>`
          )
          .join("")}</div>`
      : `<p class="muted">No lineage or shared-signal links yet.</p>`
  }`;

  let deleteControl = "";
  if (item.scope !== "starter") {
    if (pendingDeleteId === item.id) {
      deleteControl = `<button class="btn btn-danger" data-confirm-delete="${escapeHtml(item.id)}" type="button">Confirm Delete</button><button class="btn" data-cancel-delete type="button">Cancel</button>`;
    } else {
      deleteControl = `<button class="btn btn-danger" data-ask-delete="${escapeHtml(item.id)}" type="button">Delete</button>`;
    }
  }

  const scopeText = item.scope === "team" ? "Team" : item.scope === "starter" ? "Built-in" : "Local";
  const repoText = item.repoScope && item.repoScope !== "*" ? item.repoScope : "All repos";
  const refineHtml =
    item.scope !== "starter"
      ? `<div class="section-label">Refine with Copilot</div>
         <div class="refine-bar">
           <input id="refine-input" class="refine-input" type="text" placeholder="Tell Copilot how to update this experience..." />
           <button id="btn-refine" class="btn btn-primary" type="button">Refine</button>
         </div>`
      : "";
  const provenanceParts = [
    item.author ? `Author: ${escapeHtml(item.author)}` : "",
    `Source: ${escapeHtml(item.sourceProject || "bundled")}`,
    `Updated: ${escapeHtml(item.updatedAt ? formatLocalTime(item.updatedAt) : "bundled")}`,
  ].filter(Boolean);

  pane.innerHTML = `
    <div class="detail-head">
      <div class="detail-title-row">
        ${renderScoreRing(item.gdiScore)}
        <div>
          <h2 class="detail-title">${escapeHtml(item.title)}</h2>
          <div class="detail-meta-line">
            <span class="detail-meta-pill">${escapeHtml(item.type === "Fix" ? "Fix" : "Rule")}</span>
            <span>·</span>
            <span>Score ${escapeHtml(String(item.gdiScore ?? "-"))}</span>
            <span>·</span>
            <span>${item.successCount || 0} used</span>
            <span>·</span>
            <span>${escapeHtml(repoText)}</span>
            <span>·</span>
            <span>${scopeText}</span>
          </div>
          <div class="detail-id-sub">${escapeHtml(item.id)}</div>
        </div>
      </div>
      <div class="actions">${promoteTeamBtn}${validateBtn}${copyBtn}${deleteControl}${closeBtn}</div>
    </div>
    ${refineHtml}
    <div class="section-label">Trigger Signals</div>
    <div class="badges">${signals || '<span class="muted">None</span>'}</div>
    <div class="section-label">Summary</div>
    <p class="detail-box">${escapeHtml(item.summary)}</p>
    ${solution}
    ${strategy}
    ${guardrail}
    ${validation}
    <div class="section-label">Score Breakdown · Tier ${escapeHtml(item.gdiBreakdown?.tier || "B")} · ${escapeHtml(String(item.gdiBreakdown?.winRate ?? 100))}% Pass Rate</div>
    <div class="detail-breakdown">
      <div class="mini-dim">Quality <strong>${item.gdiBreakdown?.quality ?? 0}</strong><div class="bar-track"><div class="bar-fill" style="width:${item.gdiBreakdown?.quality ?? 0}%"></div></div></div>
      <div class="mini-dim">Reliability <strong>${item.gdiBreakdown?.reliability ?? 0}</strong><div class="bar-track"><div class="bar-fill" style="width:${item.gdiBreakdown?.reliability ?? 0}%"></div></div></div>
      <div class="mini-dim">Lineage <strong>${item.gdiBreakdown?.lineage ?? 0}</strong><div class="bar-track"><div class="bar-fill" style="width:${item.gdiBreakdown?.lineage ?? 0}%"></div></div></div>
      <div class="mini-dim">Freshness <strong>${item.gdiBreakdown?.freshness ?? 0}</strong><div class="bar-track"><div class="bar-fill" style="width:${item.gdiBreakdown?.freshness ?? 0}%"></div></div></div>
    </div>
    ${lineageHtml}
    <div class="section-label">Provenance (Auto-scored from loop)</div>
    <p class="muted">${provenanceParts.join(" · ")}</p>
  `;

  const submitRefine = () => {
    const val = el("refine-input")?.value?.trim();
    if (!val) return;
    mutate("/api/assets/refine", { id: item.id, feedback: val });
  };
  el("btn-refine")?.addEventListener("click", submitRefine);
  el("refine-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitRefine();
  });

  pane.querySelector("[data-close-detail]")?.addEventListener("click", () => {
    selectedId = "";
    pendingDeleteId = "";
    render();
  });
  pane.querySelector("[data-validate]")?.addEventListener("click", () => mutate("/api/arena/validate", { id: item.id }));
  pane.querySelector("[data-promote-team]")?.addEventListener("click", () => mutate("/api/assets/promote-team", { id: item.id }));
  pane.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = getAllAssets().find((a) => a.id === btn.dataset.jump);
      activeTab = target && (!target.scope || target.scope === "local") ? "local" : "assets";
      activeFilter = "all";
      activeKind = "all";
      repoFilter = "all";
      selectedId = btn.dataset.jump;
      pendingDeleteId = "";
      render();
    });
  });
  pane.querySelector("[data-copy]")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(item, null, 2));
      showBanner(`Copied ${item.id} JSON to clipboard.`);
    } catch {
      showBanner("Clipboard copy unavailable in this frame.", true);
    }
  });
  pane.querySelector("[data-ask-delete]")?.addEventListener("click", () => {
    pendingDeleteId = item.id;
    render();
  });
  pane.querySelector("[data-cancel-delete]")?.addEventListener("click", () => {
    pendingDeleteId = "";
    render();
  });
  pane.querySelector("[data-confirm-delete]")?.addEventListener("click", () => {
    pendingDeleteId = "";
    mutate("/api/assets/delete", { id: item.id });
  });
}

function collectGraphData(assets) {
  const edges = [];
  const seenShared = new Set();
  const idSet = new Set(assets.map((a) => a.id));

  for (const a of assets) {
    if (a.ruleId && idSet.has(a.ruleId)) {
      edges.push({ from: a.ruleId, to: a.id, kind: "rule", label: "applied by" });
    }
    if (a.parentId && idSet.has(a.parentId)) {
      edges.push({ from: a.parentId, to: a.id, kind: "parent", label: "refined" });
    }
    if (a.supersedes && idSet.has(a.supersedes)) {
      edges.push({ from: a.id, to: a.supersedes, kind: "supersedes", label: "supersedes" });
    }
    if (relMode === "all") {
      for (const s of a.relationships?.sharedSignals || []) {
        if (!idSet.has(s.id)) continue;
        const pairKey = [a.id, s.id].sort().join("|");
        if (seenShared.has(pairKey)) continue;
        seenShared.add(pairKey);
        edges.push({ from: a.id, to: s.id, kind: "signal", label: s.overlap.join(", ") });
      }
    }
  }
  return edges;
}

function computeForceLayout(nodes, links, width, height) {
  const n = nodes.length;
  const cx = width / 2;
  const cy = height / 2;
  const pos = new Map();
  const disp = new Map();

  nodes.forEach((node, i) => {
    const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    const radius = node.kind === "signal" ? 42 : Math.min(width, height) * 0.28;
    pos.set(node.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
    disp.set(node.id, { x: 0, y: 0 });
  });

  const padX = 78;
  const padY = 40;
  const repulseStrength = 2600;

  for (let iter = 0; iter < 120; iter++) {
    for (const node of nodes) {
      disp.get(node.id).x = 0;
      disp.get(node.id).y = 0;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const pa = pos.get(a.id);
        const pb = pos.get(b.id);
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1) {
          dx = 1;
          dy = 0.5;
          dist = 1.12;
        }
        const minGap = a.kind === "signal" || b.kind === "signal" ? 84 : 112;
        const force = repulseStrength / (dist * dist) + (dist < minGap ? (minGap - dist) * 0.14 : 0);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp.get(a.id).x += fx;
        disp.get(a.id).y += fy;
        disp.get(b.id).x -= fx;
        disp.get(b.id).y -= fy;
      }
    }

    for (const link of links) {
      const pa = pos.get(link.from);
      const pb = pos.get(link.to);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const target = link.kind === "signal" ? 105 : 122;
      const attract = (dist - target) * 0.09;
      const fx = (dx / dist) * attract;
      const fy = (dy / dist) * attract;
      disp.get(link.from).x += fx;
      disp.get(link.from).y += fy;
      disp.get(link.to).x -= fx;
      disp.get(link.to).y -= fy;
    }

    const temp = Math.max(2, 16 * (1 - iter / 120));
    for (const node of nodes) {
      const p = pos.get(node.id);
      const d = disp.get(node.id);
      d.x += (cx - p.x) * 0.035;
      d.y += (cy - p.y) * 0.045;
      const mag = Math.hypot(d.x, d.y);
      if (mag > 0) {
        const step = Math.min(mag, temp);
        p.x += (d.x / mag) * step;
        p.y += (d.y / mag) * step;
      }
      p.x = Math.max(padX, Math.min(width - padX, p.x));
      p.y = Math.max(padY, Math.min(height - padY - 14, p.y));
    }
  }
  return pos;
}

function renderRelationshipsView(listPane, allAssets) {
  if (!allAssets.length) {
    listPane.innerHTML = `<div class="empty">No experiences available to map relationships.</div>`;
    renderDetail(null);
    return;
  }
  if (selectedId && !allAssets.some((a) => a.id === selectedId)) {
    selectedId = "";
  }

  const edges = collectGraphData(allAssets);
  const showSignals = relMode === "all";

  const signalCounts = new Map();
  if (showSignals) {
    for (const a of allAssets) {
      for (const s of new Set((a.signals || []).map((x) => String(x).toLowerCase()))) {
        signalCounts.set(s, (signalCounts.get(s) || 0) + 1);
      }
    }
  }
  const sharedHubs = Array.from(signalCounts.entries())
    .filter(([, count]) => count >= 2)
    .map(([sig, count]) => ({ sig, count }))
    .sort((a, b) => b.count - a.count || a.sig.localeCompare(b.sig));
  const hubSet = new Set(sharedHubs.map((h) => h.sig));
  if (selectedSignalHub && !hubSet.has(selectedSignalHub)) {
    selectedSignalHub = "";
  }

  const connectedIdSet = new Set();
  for (const e of edges) {
    connectedIdSet.add(e.from);
    connectedIdSet.add(e.to);
  }
  if (showSignals) {
    for (const a of allAssets) {
      if ((a.signals || []).some((s) => hubSet.has(String(s).toLowerCase()))) {
        connectedIdSet.add(a.id);
      }
    }
  }

  const standaloneCount = allAssets.filter((a) => !connectedIdSet.has(a.id)).length;
  const standaloneBtn = el("chip-rel-standalone");
  if (standaloneBtn) {
    standaloneBtn.textContent = relShowStandalone
      ? `Hide Standalone (${standaloneCount})`
      : `Show Standalone (${standaloneCount})`;
    standaloneBtn.classList.toggle("active", relShowStandalone);
    standaloneBtn.classList.toggle("hidden", standaloneCount === 0);
  }

  const visibleAssets = (relShowStandalone ? allAssets : allAssets.filter((a) => connectedIdSet.has(a.id)))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  if (!visibleAssets.length) {
    listPane.innerHTML = `<div class="rel-empty-graph">${
      showSignals
        ? "No connected experiences yet. Turn on Show Standalone to view all nodes."
        : "No explicit Rule → Fix or refinement lineage yet. Switch to Lineage + Signals or Show Standalone."
    }</div>`;
    renderDetail(null);
    return;
  }

  const graphNodes = [
    ...visibleAssets.map((a) => ({ id: a.id, kind: a.type === "Fix" ? "Fix" : "Rule", asset: a })),
    ...sharedHubs.map((h) => ({ id: `sig:${h.sig}`, kind: "signal", sig: h.sig, count: h.count })),
  ];
  const graphLinks = [];
  const visibleSet = new Set(visibleAssets.map((a) => a.id));
  for (const e of edges) {
    if (e.kind !== "signal" && visibleSet.has(e.from) && visibleSet.has(e.to)) {
      graphLinks.push({ from: e.from, to: e.to, kind: e.kind, label: e.label });
    }
  }
  if (showSignals) {
    for (const a of visibleAssets) {
      for (const s of new Set((a.signals || []).map((x) => String(x).toLowerCase()))) {
        if (hubSet.has(s)) {
          graphLinks.push({ from: a.id, to: `sig:${s}`, kind: "signal" });
        }
      }
    }
  }

  const width = Math.max(540, (listPane.clientWidth || 580) - 24);
  const height = Math.max(290, Math.min(400, 230 + graphNodes.length * 14));
  const positions = computeForceLayout(graphNodes, graphLinks, width, height);

  const selectedAsset = selectedId ? allAssets.find((a) => a.id === selectedId) || null : null;
  const focusKey = selectedId || (selectedSignalHub ? `sig:${selectedSignalHub}` : "");
  const neighborIds = new Set(focusKey ? [focusKey] : []);
  if (focusKey) {
    for (const l of graphLinks) {
      if (l.from === focusKey) neighborIds.add(l.to);
      if (l.to === focusKey) neighborIds.add(l.from);
    }
  }

  const edgesSvg = graphLinks
    .map((l) => {
      const p1 = positions.get(l.from);
      const p2 = positions.get(l.to);
      if (!p1 || !p2) return "";
      const active = focusKey && (l.from === focusKey || l.to === focusKey);
      const opacity = !focusKey ? (l.kind === "signal" ? 0.45 : 0.72) : active ? 0.95 : 0.12;
      if (l.kind === "signal") {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2 - 12;
        return `<path d="M ${p1.x} ${p1.y} Q ${mx} ${my} ${p2.x} ${p2.y}" fill="none" stroke="var(--accent)" stroke-width="${active ? 1.8 : 1.2}" stroke-dasharray="4 3" stroke-opacity="${opacity}" />`;
      }
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const pad = 18;
      const x1 = p1.x + (dx / dist) * pad;
      const y1 = p1.y + (dy / dist) * pad;
      const x2 = p2.x - (dx / dist) * pad;
      const y2 = p2.y - (dy / dist) * pad;
      const color = l.kind === "supersedes" ? "var(--warn)" : "var(--accent)";
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${active ? 2.2 : 1.6}" stroke-opacity="${opacity}" marker-end="url(#kg-arrow)" />`;
    })
    .join("");

  const hubsSvg = sharedHubs
    .map((h) => {
      const nodeId = `sig:${h.sig}`;
      const p = positions.get(nodeId);
      if (!p) return "";
      const active = selectedSignalHub === h.sig || (focusKey && neighborIds.has(nodeId));
      const dimmed = Boolean(focusKey) && !neighborIds.has(nodeId);
      const text = `#${h.sig}`;
      const w = Math.max(66, text.length * 7 + 20);
      return `
      <g class="kg-hub" data-hub-sig="${escapeHtml(h.sig)}" opacity="${dimmed ? 0.2 : 1}">
        <rect x="${p.x - w / 2}" y="${p.y - 12}" width="${w}" height="24" rx="12" fill="${active ? "var(--accent)" : "var(--bg)"}" stroke="var(--accent)" stroke-width="${active ? 1.8 : 1.1}" />
        <text x="${p.x}" y="${p.y + 4}" text-anchor="middle" fill="${active ? "#ffffff" : "var(--accent)"}" font-size="10.5" font-weight="600" font-family="Consolas, monospace">${escapeHtml(text)}</text>
        <title>Shared signal #${escapeHtml(h.sig)} (${h.count} experiences)</title>
      </g>`;
    })
    .join("");

  const expNodesSvg = visibleAssets
    .map((a) => {
      const p = positions.get(a.id);
      if (!p) return "";
      const isFix = a.type === "Fix";
      const isSelected = a.id === selectedId;
      const dimmed = Boolean(focusKey) && !neighborIds.has(a.id);
      const r = Math.round(11 + Math.min(4, Math.max(0, ((a.gdiScore || 50) - 50) / 12)));
      const label = (a.title || a.id).length > 22 ? `${(a.title || a.id).slice(0, 21)}…` : a.title || a.id;
      const fill = isFix ? "var(--accent-soft)" : "var(--accent)";
      return `
      <g class="kg-node" data-node-id="${escapeHtml(a.id)}" opacity="${dimmed ? 0.2 : 1}">
        ${isSelected ? `<circle cx="${p.x}" cy="${p.y}" r="${r + 5}" fill="var(--accent-muted)" stroke="var(--accent)" stroke-width="1.5" />` : ""}
        ${
          isFix
            ? `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="var(--bg)" stroke="${fill}" stroke-width="2.5" /><circle cx="${p.x}" cy="${p.y}" r="${Math.max(4, r - 5)}" fill="${fill}" />`
            : `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="#ffffff" stroke-width="1.5" />`
        }
        <text x="${p.x}" y="${p.y + 3.5}" text-anchor="middle" fill="#ffffff" font-size="9" font-weight="700" font-family="Consolas, monospace">${isFix ? "" : "R"}</text>
        <text x="${p.x}" y="${p.y + r + 14}" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="${isSelected ? "700" : "600"}">${escapeHtml(label)}</text>
        <title>${escapeHtml(a.title)} (${a.type} · Score ${a.gdiScore ?? "-"})</title>
      </g>`;
    })
    .join("");

  listPane.innerHTML = `
    <div class="kg-stage">
      <svg class="kg-svg" viewBox="0 0 ${width} ${height}">
        <defs>
          <marker id="kg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent)" />
          </marker>
        </defs>
        ${edgesSvg}
        ${hubsSvg}
        ${expNodesSvg}
      </svg>
      <div class="kg-hint">Click node to inspect · Click #signal to highlight</div>
      <div class="kg-legend">
        <span><i class="dot dot-rule"></i>Rule</span>
        <span><i class="kg-ring-dot"></i>Fix</span>
        <span><i class="dot dot-signal"></i>#Signal (${sharedHubs.length})</span>
      </div>
    </div>
  `;

  listPane.querySelectorAll("[data-node-id]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedSignalHub = "";
      selectedId = selectedId === node.dataset.nodeId ? "" : node.dataset.nodeId;
      pendingDeleteId = "";
      render();
    });
  });
  listPane.querySelectorAll("[data-hub-sig]").forEach((hub) => {
    hub.addEventListener("click", () => {
      selectedId = "";
      selectedSignalHub = selectedSignalHub === hub.dataset.hubSig ? "" : hub.dataset.hubSig;
      render();
    });
  });

  renderDetail(selectedAsset);
}

function buildContributorStats(assets, mode = "author", scopeFilter = "all") {
  const scoped = assets.filter((item) => {
    if (scopeFilter === "team") return item.scope === "team";
    if (scopeFilter === "local") return !item.scope || item.scope === "local";
    return item.scope !== "starter";
  });

  const groups = new Map();
  for (const item of scoped) {
    const key =
      mode === "source"
        ? item.sourceProject || "unknown"
        : item.author || item.sourceProject || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return Array.from(groups.entries())
    .map(([key, items]) => {
      const sorted = [...items].sort((a, b) => (b.gdiScore || 0) - (a.gdiScore || 0));
      const n = sorted.length;
      const sum = (fn) => sorted.reduce((acc, x) => acc + fn(x), 0);
      const avgScore = sum((x) => Number(x.gdiScore || 0)) / n;
      const bestScore = Number(sorted[0]?.gdiScore || 0);
      const avgQuality = Math.round(sum((x) => Number(x.gdiBreakdown?.quality || 0)) / n);
      const avgReliability = Math.round(sum((x) => Number(x.gdiBreakdown?.reliability || 0)) / n);
      const avgLineage = Math.round(sum((x) => Number(x.gdiBreakdown?.lineage || 0)) / n);
      const avgFreshness = Math.round(sum((x) => Number(x.gdiBreakdown?.freshness || 0)) / n);
      const totalReuses = sum((x) => Number(x.successCount || 0));
      const totalFailures = sum((x) => Number(x.failureCount || 0));
      const totalRuns = totalReuses + totalFailures;
      const winRate = totalRuns > 0 ? Math.round((totalReuses / totalRuns) * 100) : 100;
      const teamCount = sorted.filter((x) => x.scope === "team").length;

      return {
        key,
        items: sorted,
        topItem: sorted[0],
        count: n,
        teamCount,
        avgScore,
        bestScore,
        avgQuality,
        avgReliability,
        avgLineage,
        avgFreshness,
        totalReuses,
        winRate,
      };
    })
    .sort((a, b) => {
      const avgDiff = b.avgScore - a.avgScore;
      if (Math.abs(avgDiff) > 0.05) return avgDiff;
      const bestDiff = b.bestScore - a.bestScore;
      if (Math.abs(bestDiff) > 0.05) return bestDiff;
      const winDiff = b.winRate - a.winRate;
      if (winDiff !== 0) return winDiff;
      return b.totalReuses - a.totalReuses;
    });
}

function renderContributorDetail(group) {
  const pane = el("detail-pane");
  if (!group) {
    pane.innerHTML = `<div class="empty">Select a contributor or source to inspect quality breakdown.</div>`;
    return;
  }

  const modeLabel = contribMode === "source" ? "Source" : "Author";
  const closeBtn = `<button class="btn btn-close" data-close-contrib type="button" title="Close detail drawer">✕</button>`;
  const expRows = group.items
    .map(
      (item) => `
      <button class="contrib-exp-item" data-jump-exp="${escapeHtml(item.id)}" type="button">
        <span class="contrib-exp-title">${escapeHtml(item.title)}</span>
        <span class="contrib-exp-meta">${item.type === "Fix" ? "Fix" : "Rule"} · ${Number(item.gdiScore || 0).toFixed(1)} · ${item.successCount || 0} used</span>
      </button>`
    )
    .join("");

  pane.innerHTML = `
    <div class="detail-head">
      <div class="detail-title-row">
        ${renderScoreRing(group.avgScore)}
        <div>
          <h2 class="detail-title">${escapeHtml(group.key)}</h2>
          <div class="detail-meta-line">
            <span class="detail-meta-pill">${modeLabel}</span>
            <span>·</span>
            <span>Avg ${group.avgScore.toFixed(1)}</span>
            <span>·</span>
            <span>Best ${group.bestScore.toFixed(1)}</span>
            <span>·</span>
            <span>${group.winRate}% pass</span>
            <span>·</span>
            <span>${group.totalReuses} reuses</span>
          </div>
          <div class="detail-id-sub">${group.count} experience(s) · ${group.teamCount} shared with team</div>
        </div>
      </div>
      <div class="actions">${closeBtn}</div>
    </div>
    <div class="section-label">Average Quality Breakdown</div>
    <div class="detail-breakdown">
      <div class="mini-dim">Quality <strong>${group.avgQuality}</strong><div class="bar-track"><div class="bar-fill" style="width:${group.avgQuality}%"></div></div></div>
      <div class="mini-dim">Reliability <strong>${group.avgReliability}</strong><div class="bar-track"><div class="bar-fill" style="width:${group.avgReliability}%"></div></div></div>
      <div class="mini-dim">Lineage <strong>${group.avgLineage}</strong><div class="bar-track"><div class="bar-fill" style="width:${group.avgLineage}%"></div></div></div>
      <div class="mini-dim">Freshness <strong>${group.avgFreshness}</strong><div class="bar-track"><div class="bar-fill" style="width:${group.avgFreshness}%"></div></div></div>
    </div>
    <div class="section-label">Top Experiences (Sorted by Quality)</div>
    <div class="contrib-exp-list">${expRows}</div>
  `;

  pane.querySelector("[data-close-contrib]")?.addEventListener("click", () => {
    selectedContribKey = "";
    render();
  });
  pane.querySelectorAll("[data-jump-exp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = getAllAssets().find((a) => a.id === btn.dataset.jumpExp);
      activeTab = target && (!target.scope || target.scope === "local") ? "local" : "assets";
      activeFilter = "all";
      activeKind = "all";
      repoFilter = "all";
      selectedId = btn.dataset.jumpExp;
      pendingDeleteId = "";
      render();
    });
  });
}

function renderContributorsView(listPane, groups) {
  if (!groups.length) {
    listPane.innerHTML = `<div class="empty">No authored or project experiences match this filter yet.</div>`;
    renderContributorDetail(null);
    return;
  }

  const trophySvg = `<svg class="trophy-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-label="Rank #1"><path d="M5 2.5h6v3.2a3 3 0 0 1-6 0V2.5Z" fill="#0969da" fill-opacity="0.18" stroke="#0969da" stroke-width="1.3"/><path d="M5 3.5H3.2a.7.7 0 0 0-.7.7v.8A2 2 0 0 0 4.5 7H5M11 3.5h1.8a.7.7 0 0 1 .7.7v.8a2 2 0 0 1-2 2H11" stroke="#0969da" stroke-width="1.2" stroke-linecap="round"/><path d="M8 8.7v2.8M5.8 13.5h4.4" stroke="#0969da" stroke-width="1.3" stroke-linecap="round"/></svg>`;

  listPane.innerHTML = `
    <div class="contrib-header">
      <span class="col-rank">#</span>
      <span>${contribMode === "source" ? "Source" : "Author"}</span>
      <span class="col-num" title="Average quality score">Avg</span>
      <span class="col-num" title="Highest single experience score">Best</span>
      <span class="col-num" title="Pass rate (successes / total runs)">Pass</span>
    </div>
    ${groups
      .map((g, idx) => {
        const rankCell =
          idx === 0
            ? `<span class="exp-rank is-top" title="Quality Rank #1">${trophySvg}</span>`
            : `<span class="exp-rank" title="Rank #${idx + 1}">${idx + 1}</span>`;
        const teamBadge =
          g.teamCount > 0
            ? `<span class="row-scope-team" title="${g.teamCount} experience(s) shared with team">${g.teamCount} shared</span>`
            : `<span class="row-scope" title="Local only">local</span>`;
        return `
        <div class="contrib-row ${g.key === selectedContribKey ? "selected" : ""}" data-contrib-key="${escapeHtml(g.key)}">
          ${rankCell}
          <div class="exp-main">
            <div class="exp-title-line">
              <span class="exp-title">${escapeHtml(g.key)}</span>
              ${teamBadge}
              <span class="row-scope" title="Total verified reuses">${g.totalReuses} reuses</span>
            </div>
            <div class="exp-summary">Top: ${escapeHtml(g.topItem?.title || "-")} · ${g.count} exp</div>
          </div>
          <span class="exp-score col-num ${idx === 0 ? "contrib-score-top" : ""}" title="Average quality score">${g.avgScore.toFixed(1)}</span>
          <span class="exp-reuses col-num" title="Highest single experience score">${g.bestScore.toFixed(1)}</span>
          <span class="exp-reuses col-num" title="Pass rate (successes / total runs)">${g.winRate}%</span>
        </div>`;
      })
      .join("")}`;

  listPane.querySelectorAll(".contrib-row").forEach((row) => {
    row.addEventListener("click", () => {
      selectedContribKey = selectedContribKey === row.dataset.contribKey ? "" : row.dataset.contribKey;
      render();
    });
  });

  const selectedGroup = selectedContribKey ? groups.find((g) => g.key === selectedContribKey) || null : null;
  renderContributorDetail(selectedGroup);
}

function render() {
  if (!state) return;
  const rules = state.rules || [];
  const fixes = state.fixes || [];
  const allAssets = [...rules, ...fixes];
  const totalReuses = allAssets.reduce((sum, a) => sum + (a.successCount || 0), 0);
  const linkCount = collectGraphData(allAssets).length;

  const syncTime = state.config?.lastAutoPullAt
    ? ` · synced ${formatLocalTime(state.config.lastAutoPullAt).slice(11, 16)}`
    : "";
  const tel = el("telemetry-line");
  if (tel) {
    tel.textContent = `${rules.length} rules · ${fixes.length} fixes · ${state.counts?.teamAssets || 0} shared · ${totalReuses} hits${syncTime}`;
    tel.title = state.syncRepoPath
      ? `Sync repo: ${state.syncRepoPath}`
      : `Auto-clone repo: ${state.config?.syncRepo || "JiaqiZhang-Dev/copilot-evo"}`;
  }

  const contributorGroups = buildContributorStats(getAllAssets(), contribMode, contribScope);
  const localCount = allAssets.filter((a) => !a.scope || a.scope === "local").length;
  const teamCount = allAssets.filter((a) => a.scope === "team").length;
  const starterCount = allAssets.filter((a) => a.scope === "starter").length;
  const sharedCount = teamCount + starterCount;

  el("count-assets").textContent = String(sharedCount);
  if (el("count-local")) el("count-local").textContent = String(localCount);
  el("count-contributors").textContent = String(contributorGroups.length);
  el("count-links").textContent = String(linkCount);
  el("count-events").textContent = String(state.counts?.events || 0);

  if (el("chip-all")) {
    el("chip-all").textContent = `All ${sharedCount}`;
    el("chip-all").classList.toggle("hidden", activeTab === "local");
  }
  if (el("chip-team")) {
    el("chip-team").textContent = `Team Shared ${teamCount}`;
    el("chip-team").classList.toggle("hidden", activeTab === "local");
  }
  if (el("chip-starter")) {
    el("chip-starter").textContent = `Built-in ${starterCount}`;
    el("chip-starter").classList.toggle("hidden", activeTab === "local");
  }

  const itemsForTab = activeTab === "assets" || activeTab === "local" ? getFilteredAssets() : allAssets;
  if (selectedId && !itemsForTab.some((i) => i.id === selectedId)) {
    selectedId = "";
    pendingDeleteId = "";
  }
  if (selectedContribKey && !contributorGroups.some((g) => g.key === selectedContribKey)) {
    selectedContribKey = "";
  }

  el("assets-toolbar").classList.toggle("hidden", activeTab !== "assets" && activeTab !== "local");
  el("contributors-toolbar")?.classList.toggle("hidden", activeTab !== "contributors");
  el("rel-toolbar").classList.toggle("hidden", activeTab !== "relationships");
  el("events-toolbar").classList.toggle("hidden", activeTab !== "events");
  const hasDetail =
    ((activeTab === "assets" || activeTab === "local" || activeTab === "relationships") && Boolean(selectedId)) ||
    (activeTab === "contributors" && Boolean(selectedContribKey));
  el("content").classList.toggle("single-pane", !hasDetail);
  el("content").classList.toggle("graph-pane", activeTab === "relationships" && hasDetail);
  el("pane-splitter")?.classList.toggle("hidden", !hasDetail);
  el("detail-pane").classList.toggle("hidden", !hasDetail);

  document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === activeTab));
  document.querySelectorAll(".chip[data-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.filter === activeFilter));
  document.querySelectorAll(".seg[data-kind]").forEach((btn) => btn.classList.toggle("active", btn.dataset.kind === activeKind));
  document.querySelectorAll(".seg[data-contrib-mode]").forEach((btn) => btn.classList.toggle("active", btn.dataset.contribMode === contribMode));
  document.querySelectorAll(".chip[data-contrib-scope]").forEach((btn) => btn.classList.toggle("active", btn.dataset.contribScope === contribScope));
  document.querySelectorAll(".chip[data-event-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.eventFilter === eventFilter));
  document.querySelectorAll(".chip[data-rel-mode]").forEach((btn) => btn.classList.toggle("active", btn.dataset.relMode === relMode));
  const scopeFilters = el("scope-filters");
  if (scopeFilters) scopeFilters.classList.toggle("hidden", activeTab === "local");
  const repoSel = el("repo-select");
  if (repoSel) {
    repoSel.value = repoFilter;
    repoSel.classList.toggle("is-filtered", repoFilter !== "all");
    const matchingOpt = repoSel.querySelector('option[value="matching"]');
    const onlyOpt = repoSel.querySelector('option[value="only"]');
    if (matchingOpt) {
      matchingOpt.textContent = state.currentRepo ? `${state.currentRepo} + Global` : "Global (*) Only";
    }
    if (onlyOpt) {
      onlyOpt.textContent = state.currentRepo ? `Only ${state.currentRepo}` : "Repo-specific Only";
    }
  }

  const listPane = el("list-pane");

  if (activeTab === "contributors") {
    renderContributorsView(listPane, contributorGroups);
    return;
  }

  if (activeTab === "relationships") {
    renderRelationshipsView(listPane, getAllAssets());
    return;
  }

  if (activeTab === "events") {
    const curSid = state.currentSession?.sessionId || "";
    const curSname = state.currentSession?.sessionName || "";
    const sessionBtn = el("chip-event-session");
    if (sessionBtn) {
      sessionBtn.classList.toggle("active", eventSessionFilter === "current");
      sessionBtn.textContent = curSname ? `Session: ${curSname}` : curSid ? `Session: ${curSid.slice(0, 8)}` : "This Session";
    }
    const events = getFilteredEvents();
    listPane.innerHTML = events.length
      ? `<div class="timeline">${events
          .map((ev) => {
            const meta = formatEventMeta(ev);
            const isWarn = meta.cls === "ev-warn";
            const sigs = (ev.signals || []).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
            const shortSid = ev.sessionId ? ev.sessionId.slice(0, 8) : "";
            const sessionLabel = ev.sessionName
              ? `${ev.sessionName}${shortSid ? ` · ${shortSid}` : ""}`
              : shortSid || (ev.project ? ev.project : "");
            const sessionBadge = ev.sessionId
              ? `<button class="event-session-pill" data-ev-session="${escapeHtml(ev.sessionId)}" type="button" title="Filter events from session ${escapeHtml(ev.sessionId)}">${escapeHtml(sessionLabel)}</button>`
              : sessionLabel
                ? `<span class="badge">${escapeHtml(sessionLabel)}</span>`
                : "";
            return `
            <div class="event-row ${isWarn ? "is-warn" : ""}">
              <div class="event-top">
                <div class="event-top-left">
                  <span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span>
                  ${sessionBadge}
                </div>
                <span class="muted" title="${escapeHtml(ev.ts || "")}">${escapeHtml(formatLocalTime(ev.ts))}</span>
              </div>
              <div class="event-detail">${escapeHtml(meta.desc)}</div>
              ${sigs ? `<div class="badges">${sigs}</div>` : ""}
            </div>`;
          })
          .join("")}</div>`
      : `<div class="empty">No matching evolution events recorded.</div>`;
    listPane.querySelectorAll("[data-ev-session]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.dataset.evSession;
        eventSessionFilter = eventSessionFilter === sid ? "" : sid;
        render();
      });
    });
    return;
  }

  const items = itemsForTab;
  if (!items.length) {
    listPane.innerHTML = `<div class="empty">${
      activeTab === "local"
        ? "No local experiences right now. Copilot automatically captures reusable rules and verified fixes here."
        : "No experiences match the current filters."
    }</div>`;
    renderDetail(null);
    return;
  }

  const showShareCol = activeTab === "local";
  listPane.innerHTML = `
    <div class="exp-header ${showShareCol ? "has-share" : ""}">
      <span class="col-rank">#</span>
      <span>Experience</span>
      <span class="col-num">Score</span>
      <span class="col-num">Used</span>
      ${showShareCol ? `<span class="col-action" title="Share to Team"></span>` : ""}
    </div>
    ${items
      .map((item, idx) => {
        const isFix = item.type === "Fix";
        const repoLabel =
          item.repoScope && item.repoScope !== "*" ? escapeHtml(item.repoScope) : "All repos";
        const footText =
          item.scope === "team"
            ? item.author
              ? `Shared by ${escapeHtml(item.author)}`
              : "Team Shared"
            : item.scope === "starter"
              ? "Built-in"
              : item.sourceProject
                ? `From ${escapeHtml(item.sourceProject)}`
                : "";
        const kindTooltip = isFix ? "Fix: verified bug resolution" : "Rule: reusable guideline";
        const uses = item.successCount || 0;
        const scoreVal = item.gdiScore !== undefined ? Number(item.gdiScore).toFixed(1) : "-";
        const trophySvg = `<svg class="trophy-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-label="Rank #1"><path d="M5 2.5h6v3.2a3 3 0 0 1-6 0V2.5Z" fill="#0969da" fill-opacity="0.18" stroke="#0969da" stroke-width="1.3"/><path d="M5 3.5H3.2a.7.7 0 0 0-.7.7v.8A2 2 0 0 0 4.5 7H5M11 3.5h1.8a.7.7 0 0 1 .7.7v.8a2 2 0 0 1-2 2H11" stroke="#0969da" stroke-width="1.2" stroke-linecap="round"/><path d="M8 8.7v2.8M5.8 13.5h4.4" stroke="#0969da" stroke-width="1.3" stroke-linecap="round"/></svg>`;
        const rankCell =
          idx === 0
            ? `<span class="exp-rank is-top" title="Rank #1">${trophySvg}</span>`
            : `<span class="exp-rank" title="Rank #${idx + 1}">${idx + 1}</span>`;
        const isSharing = sharingId === item.id;
        const shareIconSvg = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 10.8V2.6m0 0L5 5.6M8 2.6l3 3M3 10.4v2.1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        const shareCell = showShareCol
          ? `<div class="col-action"><button class="row-share-icon" data-quick-share="${escapeHtml(item.id)}" type="button" ${isSharing ? "disabled" : ""} title="Share with your team" aria-label="Share with your team">${shareIconSvg}</button></div>`
          : "";
        return `
        <div class="exp-row ${showShareCol ? "has-share" : ""} ${item.id === selectedId ? "selected" : ""} ${item.id === justSharedId ? "just-shared" : ""}" data-id="${escapeHtml(item.id)}">
          ${rankCell}
          <div class="exp-main">
            <div class="exp-title-line">
              <span class="exp-title">${escapeHtml(item.title)}</span>
              <span class="row-kind ${isFix ? "is-fix" : "is-rule"}" title="${kindTooltip}">${isFix ? "Fix" : "Rule"}</span>
              <span class="row-scope" title="Repository scope">${repoLabel}</span>
            </div>
            <div class="exp-summary">${escapeHtml(item.summary)}</div>
            ${footText ? `<div class="exp-foot">${footText}</div>` : ""}
          </div>
          <span class="exp-score col-num" title="Composite score">${scoreVal}</span>
          <span class="exp-reuses col-num" title="Verified reuse count">${uses}</span>
          ${shareCell}
        </div>`;
      })
      .join("")}`;

  listPane.querySelectorAll("[data-quick-share]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      mutate("/api/assets/promote-team", { id: btn.dataset.quickShare });
    });
  });

  listPane.querySelectorAll(".exp-row").forEach((card) => {
    card.addEventListener("click", () => {
      selectedId = selectedId === card.dataset.id ? "" : card.dataset.id;
      pendingDeleteId = "";
      render();
    });
  });

  const selected = selectedId ? items.find((i) => i.id === selectedId) || null : null;
  renderDetail(selected);
}

async function loadState(applyServerView = false) {
  const res = await fetch("/api/state", { cache: "no-store" });
  state = await res.json();
  if (applyServerView && state.viewState) {
    const serverTab = state.viewState.tab === "arena" ? "contributors" : state.viewState.tab;
    activeTab = state.viewState.filter === "local" ? "local" : serverTab || activeTab;
    activeFilter = state.viewState.filter === "local" ? "all" : state.viewState.filter || activeFilter;
    if (state.viewState.assetId) selectedId = state.viewState.assetId;
  }
  render();
}

async function mutate(endpoint, body) {
  showBanner("");
  const buttons = [el("btn-pull")].filter(Boolean);
  buttons.forEach((b) => (b.disabled = true));
  if (endpoint === "/api/assets/promote-team" && body?.id) {
    sharingId = body.id;
    setLoadingOverlay(true, "Sharing with your team...");
    render();
  } else if (endpoint === "/api/sync/pull") {
    setLoadingOverlay(true, "Syncing team experiences...");
  } else if (endpoint === "/api/arena/validate") {
    setLoadingOverlay(true, "Running validation...");
  } else if (endpoint === "/api/assets/refine") {
    setLoadingOverlay(true, "Sending feedback to Copilot...");
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evo-Token": canvasToken,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      showBanner(data.error || "Operation failed.", true);
    } else if (endpoint === "/api/sync/pull") {
      showToast("Synced with team", `${data.imported || 0} new, ${data.updated || 0} updated experience(s).`);
    } else if (endpoint === "/api/assets/promote") {
      showBanner(`Promoted ${data.asset?.id || "experience"}.`);
    } else if (endpoint === "/api/assets/promote-team") {
      justSharedId = data.asset?.id || body?.id || "";
      setTimeout(() => {
        justSharedId = "";
      }, 2200);
      if (data.pushed) {
        showToast(
          "Shared with your team!",
          `Thanks for helping everyone evolve — "${data.asset?.title || data.asset?.id}" is now live.`
        );
      } else if (data.syncError) {
        showBanner(`Marked ${data.asset?.id || "experience"} as team, but Git push failed: ${data.syncError}`, true);
      } else {
        showToast(
          "Marked as team experience!",
          `Thanks for contributing "${data.asset?.title || data.asset?.id}".`
        );
      }
    } else if (endpoint === "/api/assets/feedback") {
      showBanner(`Updated ${data.asset?.id || "asset"} (Score ${data.gdiScore ?? "-"}).`);
    } else if (endpoint === "/api/assets/refine") {
      showToast("Sent to Copilot", "Refining this experience in chat...");
      if (el("refine-input")) el("refine-input").value = "";
    } else if (endpoint === "/api/arena/validate") {
      if (data.passed) {
        showBanner(`Validation PASSED for ${data.assetId}.`);
      } else {
        const failed = (data.results || []).find((r) => !r.passed);
        const detail = failed?.output ? ` — ${failed.output.split(/\r?\n/)[0].slice(0, 140)}` : "";
        showBanner(`Validation FAILED for ${data.assetId}${failed ? ` (${failed.command})` : ""}${detail}`, true);
      }
    } else if (endpoint === "/api/assets/delete") {
      showBanner(`Deleted ${data.deletedId || "asset"}.`);
    }
    sharingId = "";
    setLoadingOverlay(false);
    await loadState(false);
  } catch (err) {
    sharingId = "";
    setLoadingOverlay(false);
    showBanner(err.message, true);
    render();
  } finally {
    sharingId = "";
    setLoadingOverlay(false);
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function init() {
  const cfgRes = await fetch("/api/config", { cache: "no-store" });
  const cfg = await cfgRes.json();
  canvasToken = cfg.canvasToken || "";

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      pendingDeleteId = "";
      render();
    });
  });

  document.querySelectorAll(".chip[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
      render();
    });
  });

  document.querySelectorAll(".seg[data-kind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeKind = btn.dataset.kind;
      render();
    });
  });

  document.querySelectorAll(".seg[data-contrib-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      contribMode = btn.dataset.contribMode;
      selectedContribKey = "";
      render();
    });
  });

  document.querySelectorAll(".chip[data-contrib-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      contribScope = btn.dataset.contribScope;
      selectedContribKey = "";
      render();
    });
  });

  document.querySelectorAll(".chip[data-event-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      eventFilter = btn.dataset.eventFilter;
      render();
    });
  });

  el("chip-event-session")?.addEventListener("click", () => {
    eventSessionFilter = eventSessionFilter === "current" ? "" : "current";
    render();
  });

  document.querySelectorAll(".chip[data-rel-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      relMode = btn.dataset.relMode;
      selectedSignalHub = "";
      render();
    });
  });

  el("chip-rel-standalone")?.addEventListener("click", () => {
    relShowStandalone = !relShowStandalone;
    render();
  });

  el("repo-select")?.addEventListener("change", (e) => {
    repoFilter = e.target.value || "all";
    render();
  });

  el("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });

  el("btn-pull")?.addEventListener("click", () => mutate("/api/sync/pull", {}));

  const splitter = el("pane-splitter");
  const content = el("content");
  if (splitter && content) {
    let dragging = false;
    splitter.addEventListener("pointerdown", (e) => {
      dragging = true;
      splitter.classList.add("dragging");
      splitter.setPointerCapture(e.pointerId);
    });
    splitter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = content.getBoundingClientRect();
      if (!rect.height) return;
      const pct = Math.max(20, Math.min(76, ((e.clientY - rect.top) / rect.height) * 100));
      const prop = activeTab === "relationships" ? "--split-top-graph" : "--split-top";
      content.style.setProperty(prop, `${pct.toFixed(1)}%`);
    });
    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove("dragging");
    };
    splitter.addEventListener("pointerup", stopDrag);
    splitter.addEventListener("pointercancel", stopDrag);
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (selectedId || selectedContribKey)) {
      selectedId = "";
      selectedContribKey = "";
      pendingDeleteId = "";
      render();
    }
  });

  await loadState(true);

  const es = new EventSource("/api/events");
  es.addEventListener("update", (ev) => {
    let reason = "";
    try {
      reason = JSON.parse(ev.data || "{}").reason || "";
    } catch {
      reason = "";
    }
    loadState(reason === "open" || reason === "action");
  });
}

init();
