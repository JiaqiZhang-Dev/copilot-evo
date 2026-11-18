let state = null;
let canvasToken = "";
let activeTab = "assets";
let activeFilter = "all";
let activeKind = "all";
let repoFilter = "all";
let eventFilter = "all";
let relMode = "all";
let searchQuery = "";
let selectedId = "";
let pendingDeleteId = "";

const el = (id) => document.getElementById(id);

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
  return [...(state.genes || []), ...(state.capsules || [])].sort((a, b) => {
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
  return getAllAssets().filter((item) => {
    if (activeKind !== "all" && item.type !== activeKind) return false;
    if (activeFilter !== "all" && item.scope !== activeFilter) return false;
    if (repoFilter === "matching") {
      const r = (item.repoScope || "*").toLowerCase();
      if (r !== "*" && (!curRepo || r !== curRepo)) return false;
    }
    if (!q) return true;
    const text = `${item.id} ${item.title} ${item.summary} ${item.solution || ""} ${item.repoScope || ""} ${(item.signals || []).join(" ")}`.toLowerCase();
    return text.includes(q);
  });
}

function getFilteredEvents() {
  const events = state?.events || [];
  if (eventFilter === "all") return events;
  if (eventFilter === "signals") return events.filter((ev) => ev.event === "tool_failure");
  return events.filter((ev) => ev.event !== "tool_failure");
}

function formatLocalTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function displayTypeWord(type) {
  return type === "Capsule" ? "Fix" : type === "Gene" ? "Rule" : type || "Experience";
}

function formatEventMeta(ev) {
  switch (ev.event) {
    case "solidify":
      return { label: "Solidified", cls: "ev-ok", desc: `${displayTypeWord(ev.assetType)}: ${ev.assetId || ""}` };
    case "sync_push":
      return { label: "Team Push", cls: "ev-ok", desc: `Synced ${ev.genesCount || 0} Rules · ${ev.capsulesCount || 0} Fixes` };
    case "sync_pull":
      return { label: "Team Pull", cls: "ev-ok", desc: `Imported ${ev.imported || 0} team experience(s)` };
    case "sync_scores":
      return { label: "Auto Score Sync", cls: "ev-ok", desc: "Synced team experience score deltas" };
    case "promote":
    case "promote_team":
      return { label: "Promoted", cls: "ev-ok", desc: `${displayTypeWord(ev.assetType)}: ${ev.assetId || ""}` };
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
  return type === "Capsule" ? "FIX" : "RULE";
}

function renderScoreRing(score, isFix) {
  const val = Math.max(0, Math.min(100, Number(score || 0)));
  const r = 17;
  const circ = 2 * Math.PI * r;
  const dash = ((val / 100) * circ).toFixed(1);
  const stroke = isFix ? "var(--accent)" : "var(--gene)";
  return `
    <svg class="score-ring" viewBox="0 0 44 44" aria-label="Score ${val}">
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--border)" stroke-width="4" />
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="${stroke}" stroke-width="4"
        stroke-linecap="round" stroke-dasharray="${dash} ${circ.toFixed(1)}" transform="rotate(-90 22 22)" />
      <text x="22" y="25.5" text-anchor="middle" fill="var(--text)" font-size="10.5" font-weight="700" font-family="Consolas, monospace">${Math.round(val)}</text>
    </svg>`;
}

function renderDetail(item) {
  const pane = el("detail-pane");
  if (!item) {
    pane.innerHTML = `<div class="empty">Select an Experience to inspect its signals, steps, and validation evidence.</div>`;
    return;
  }

  const kindCls = item.type === "Capsule" ? "kind-capsule" : "kind-gene";
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

  const promoteTeamBtn =
    item.scope === "local"
      ? `<button class="btn btn-primary" data-promote-team="${escapeHtml(item.id)}" type="button" title="Sanitize, mark as team, and push to the team Git repository">Share to Team</button>`
      : "";
  const copyBtn = `<button class="btn" data-copy="${escapeHtml(item.id)}" type="button">Copy JSON</button>`;

  const rel = item.relationships || {};
  const relLinks = [];
  if (rel.gene) relLinks.push({ role: "Rule", item: rel.gene });
  if (rel.parent) relLinks.push({ role: "Parent", item: rel.parent });
  if (rel.supersedes) relLinks.push({ role: "Supersedes", item: rel.supersedes });
  for (const child of rel.children || []) relLinks.push({ role: child.type === "Capsule" ? "Fix" : "Derived", item: child });
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

  pane.innerHTML = `
    <div class="detail-head">
      <div class="detail-title-row">
        ${renderScoreRing(item.gdiScore, item.type === "Capsule")}
        <div>
          <h2 class="detail-title">${escapeHtml(item.title)}</h2>
          <div class="detail-id">
            <span class="badge ${kindCls}">${kindLabel(item.type)}</span>
            <span class="badge gdi-badge">Score ${escapeHtml(String(item.gdiScore ?? "-"))}</span>
            <span class="badge">${item.successCount || 0} reuses</span>
            <span class="badge">${escapeHtml(item.repoScope && item.repoScope !== "*" ? item.repoScope : "global (*)")}</span>
            <span>${escapeHtml(item.id)}</span> · <span>${escapeHtml(item.scope || "local")}</span>
          </div>
        </div>
      </div>
      <div class="actions">${promoteTeamBtn}${copyBtn}${deleteControl}</div>
    </div>
    <div class="section-label">Trigger Signals</div>
    <div class="badges">${signals || '<span class="muted">None</span>'}</div>
    <div class="section-label">Summary</div>
    <p class="detail-box">${escapeHtml(item.summary)}</p>
    ${solution}
    ${strategy}
    ${guardrail}
    ${validation}
    ${lineageHtml}
    <div class="section-label">Provenance (Auto-scored from loop)</div>
    <p class="muted">Reuses: ${item.successCount || 0} · Failures: ${item.failureCount || 0} · Source: ${escapeHtml(item.sourceProject || "bundled")} · Updated: ${escapeHtml(item.updatedAt ? formatLocalTime(item.updatedAt) : "bundled")}</p>
  `;

  pane.querySelector("[data-promote-team]")?.addEventListener("click", () => mutate("/api/assets/promote-team", { id: item.id }));
  pane.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = "assets";
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
    if (a.geneId && idSet.has(a.geneId)) {
      edges.push({ from: a.geneId, to: a.id, kind: "gene", label: "applied by" });
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

function renderRelationshipsView(listPane, allAssets) {
  if (!allAssets.length) {
    listPane.innerHTML = `<div class="empty">No experiences available to map relationships.</div>`;
    renderDetail(null);
    return;
  }
  if (!allAssets.some((a) => a.id === selectedId)) {
    selectedId = allAssets[0].id;
  }

  const rules = allAssets.filter((a) => a.type !== "Capsule");
  const fixes = allAssets.filter((a) => a.type === "Capsule");
  const edges = collectGraphData(allAssets);
  const showSignals = relMode === "all";

  // Collect shared signals (signals used by >= 2 experiences) as hub nodes.
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
    .map(([sig]) => sig);

  const availW = Math.max(520, (listPane.clientWidth || 580) - 36);
  const nodeW = 186;
  const nodeH = 38;
  const rowGap = 48;
  const padX = 14;
  const padY = 14;

  // Layout zones: Rules on left, Signal Hubs in center (if any), Fixes on right (or 2nd column if no hubs).
  const hasHubs = sharedHubs.length > 0;
  const hasFixes = fixes.length > 0;
  const hubW = 126;
  const hubH = 26;

  let svgW = availW;
  let leftX = padX;
  let hubX = padX + nodeW + 46;
  let rightX = padX + nodeW + 46;

  if (hasHubs && hasFixes) {
    svgW = Math.max(availW, padX * 2 + nodeW * 2 + hubW + 100);
    hubX = Math.round((svgW - hubW) / 2);
    rightX = svgW - padX - nodeW;
  } else if (hasHubs) {
    svgW = Math.max(availW, padX * 2 + nodeW + hubW + 90);
    hubX = svgW - padX - hubW - 12;
  } else if (hasFixes) {
    svgW = Math.max(availW, padX * 2 + nodeW * 2 + 80);
    rightX = svgW - padX - nodeW;
  } else if (rules.length > 4) {
    // Spread standalone rules neatly into 2 columns so they fit cleanly without giant vertical scroll.
    svgW = Math.max(availW, padX * 2 + nodeW * 2 + 60);
    rightX = svgW - padX - nodeW;
  }

  const positions = new Map();
  if (!hasHubs && !hasFixes && rules.length > 4) {
    const half = Math.ceil(rules.length / 2);
    rules.slice(0, half).forEach((r, i) => positions.set(r.id, { x: leftX, y: padY + i * rowGap }));
    rules.slice(half).forEach((r, i) => positions.set(r.id, { x: rightX, y: padY + i * rowGap }));
  } else {
    rules.forEach((r, i) => positions.set(r.id, { x: leftX, y: padY + i * rowGap }));
    fixes.forEach((f, i) => positions.set(f.id, { x: rightX, y: padY + i * rowGap }));
  }

  const hubPositions = new Map();
  const maxNodesRows = Math.max(
    !hasHubs && !hasFixes && rules.length > 4 ? Math.ceil(rules.length / 2) : rules.length,
    fixes.length,
    1
  );
  const contentH = maxNodesRows * rowGap;
  const hubStep = sharedHubs.length ? Math.max(36, Math.min(54, contentH / sharedHubs.length)) : 40;
  const hubStartY = padY + Math.max(0, (contentH - sharedHubs.length * hubStep) / 2);
  sharedHubs.forEach((sig, i) => {
    hubPositions.set(sig, { x: hubX, y: Math.round(hubStartY + i * hubStep) });
  });

  const svgH = Math.max(
    150,
    padY * 2 + Math.max(maxNodesRows * rowGap - 10, sharedHubs.length * hubStep)
  );

  // Connected set for highlighting around selectedId.
  const selectedAsset = allAssets.find((a) => a.id === selectedId) || allAssets[0];
  const connectedIds = new Set([selectedId]);
  for (const e of edges) {
    if (e.from === selectedId) connectedIds.add(e.to);
    if (e.to === selectedId) connectedIds.add(e.from);
  }

  // Draw lineage edges (solid directed arrows).
  const lineageEdgesSvg = edges
    .filter((e) => e.kind !== "signal")
    .map((e) => {
      const p1 = positions.get(e.from);
      const p2 = positions.get(e.to);
      if (!p1 || !p2) return "";
      const x1 = p1.x + (p2.x > p1.x ? nodeW : 0);
      const y1 = p1.y + nodeH / 2;
      const x2 = p2.x + (p2.x > p1.x ? 0 : nodeW);
      const y2 = p2.y + nodeH / 2;
      const isActive = e.from === selectedId || e.to === selectedId;
      const color = e.kind === "supersedes" ? "var(--warn)" : "var(--accent)";
      const cx = (x1 + x2) / 2;
      const d = p1.x === p2.x
        ? `M ${p1.x + nodeW} ${y1} C ${p1.x + nodeW + 28} ${y1}, ${p2.x + nodeW + 28} ${y2}, ${p2.x + nodeW} ${y2}`
        : `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${isActive ? 2 : 1.4}" stroke-opacity="${isActive ? 0.95 : 0.45}" marker-end="url(#arrow)" />`;
    })
    .join("");

  // Draw Signal hub links (experience <-> shared signal hub).
  const signalEdgesSvg = showSignals
    ? allAssets
        .flatMap((a) => {
          const p = positions.get(a.id);
          if (!p) return [];
          const sigs = Array.from(new Set((a.signals || []).map((x) => String(x).toLowerCase())));
          return sigs
            .filter((s) => hubPositions.has(s))
            .map((s) => {
              const hp = hubPositions.get(s);
              const fromLeft = p.x < hp.x;
              const x1 = fromLeft ? p.x + nodeW : p.x;
              const y1 = p.y + nodeH / 2;
              const x2 = fromLeft ? hp.x : hp.x + hubW;
              const y2 = hp.y + hubH / 2;
              const isActive = a.id === selectedId || (selectedAsset?.signals || []).includes(s);
              const cx = (x1 + x2) / 2;
              return `<path d="M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}" fill="none" stroke="var(--accent)" stroke-width="${isActive ? 1.6 : 1}" stroke-dasharray="4 3" stroke-opacity="${isActive ? 0.85 : 0.22}" />`;
            });
        })
        .join("")
    : "";

  const hubsSvg = showSignals
    ? sharedHubs
        .map((sig) => {
          const hp = hubPositions.get(sig);
          const active = (selectedAsset?.signals || []).map((x) => x.toLowerCase()).includes(sig);
          const label = sig.length > 14 ? `${sig.slice(0, 13)}…` : sig;
          return `
          <g opacity="${active ? 1 : 0.72}">
            <rect x="${hp.x}" y="${hp.y}" width="${hubW}" height="${hubH}" rx="13" fill="${active ? "var(--accent-muted)" : "var(--bg)"}" stroke="${active ? "var(--accent)" : "var(--border)"}" stroke-width="${active ? 1.4 : 1}" />
            <text x="${hp.x + hubW / 2}" y="${hp.y + 17}" text-anchor="middle" fill="${active ? "var(--accent)" : "var(--muted)"}" font-size="10.5" font-family="Consolas, monospace">#${escapeHtml(label)}</text>
            <title>Shared signal: ${escapeHtml(sig)}</title>
          </g>`;
        })
        .join("")
    : "";

  const nodeSvg = allAssets
    .map((a) => {
      const pos = positions.get(a.id);
      if (!pos) return "";
      const selected = a.id === selectedId;
      const related = connectedIds.has(a.id);
      const isCap = a.type === "Capsule";
      const stroke = selected ? "var(--accent)" : "var(--border)";
      const fill = selected ? "var(--accent-muted)" : "var(--bg)";
      const dotColor = isCap ? "var(--accent)" : "var(--gene)";
      const shortTitle = (a.title || a.id).slice(0, 23) + ((a.title || "").length > 23 ? "…" : "");
      return `
      <g class="graph-node" data-node-id="${escapeHtml(a.id)}" opacity="${related || selected ? 1 : 0.48}">
        <rect x="${pos.x}" y="${pos.y}" width="${nodeW}" height="${nodeH}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="${selected ? 1.8 : 1}" />
        <circle cx="${pos.x + 12}" cy="${pos.y + 13}" r="3.5" fill="${dotColor}" />
        <text x="${pos.x + 20}" y="${pos.y + 16}" fill="${dotColor}" font-size="9.5" font-weight="700" font-family="Consolas, monospace">${isCap ? "FIX" : "RULE"} · ${a.gdiScore || "-"} · ${a.successCount || 0}x</text>
        <text x="${pos.x + 10}" y="${pos.y + 30}" fill="var(--text)" font-size="11" font-weight="600">${escapeHtml(shortTitle)}</text>
        <title>${escapeHtml(a.title)} (${escapeHtml(a.id)})</title>
      </g>`;
    })
    .join("");

  listPane.innerHTML = `
    <div class="graph-legend">
      <div class="legend-items">
        <span><i class="dot dot-rule"></i>Rule</span>
        <span><i class="dot dot-fix"></i>Fix</span>
        <span><i class="dot dot-signal"></i>Shared Signal Hub (${sharedHubs.length})</span>
      </div>
      <span>Click a node to highlight connections</span>
    </div>
    <div class="graph-wrap">
      <svg class="graph-svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent)" />
          </marker>
        </defs>
        ${signalEdgesSvg}
        ${lineageEdgesSvg}
        ${hubsSvg}
        ${nodeSvg}
      </svg>
    </div>
  `;

  listPane.querySelectorAll("[data-node-id]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedId = node.dataset.nodeId;
      render();
    });
  });

  renderDetail(selectedAsset);
}

function renderArenaView(listPane, allAssets) {
  if (!allAssets.length) {
    listPane.innerHTML = `<div class="empty">No Experiences available to rank yet.</div>`;
    return;
  }

  const leaderboardHtml = allAssets
    .map((item, idx) => {
      const b = item.gdiBreakdown || {};
      const kindCls = item.type === "Capsule" ? "kind-capsule" : "kind-gene";
      const hasVal = Array.isArray(item.validation) && item.validation.length > 0;
      return `
      <div class="lb-row ${idx === 0 ? "rank-1" : ""}">
        <div class="lb-top">
          <div class="card-title-wrap">
            <span class="badge">#${idx + 1}</span>
            <span class="tier-badge tier-${escapeHtml(b.tier || "B")}">${escapeHtml(b.tier || "B")}</span>
            <span class="badge ${kindCls}">${kindLabel(item.type)}</span>
            <span class="card-title">${escapeHtml(item.title)}</span>
          </div>
          <div class="actions">
            <span class="badge gdi-badge">Score ${item.gdiScore || 0}</span>
            <span class="badge">${item.successCount || 0} reuses</span>
            <span class="badge">${b.winRate ?? 100}% win</span>
            ${hasVal ? `<button class="btn" data-validate="${escapeHtml(item.id)}" type="button">Run Validation</button>` : ""}
            <button class="btn" data-inspect="${escapeHtml(item.id)}" type="button">Inspect</button>
          </div>
        </div>
        <div class="lb-dims">
          <div class="mini-dim">Quality <strong>${b.quality || 0}</strong><div class="bar-track"><div class="bar-fill gene" style="width:${b.quality || 0}%"></div></div></div>
          <div class="mini-dim">Reliability <strong>${b.reliability || 0}</strong><div class="bar-track"><div class="bar-fill" style="width:${b.reliability || 0}%"></div></div></div>
          <div class="mini-dim">Lineage <strong>${b.lineage || 0}</strong><div class="bar-track"><div class="bar-fill" style="width:${b.lineage || 0}%"></div></div></div>
          <div class="mini-dim">Freshness <strong>${b.freshness || 0}</strong><div class="bar-track"><div class="bar-fill" style="width:${b.freshness || 0}%"></div></div></div>
        </div>
      </div>`;
    })
    .join("");

  listPane.innerHTML = `
    <div class="arena-wrap">
      <div class="arena-section">
        <div class="arena-header">
          <h3>Experience Leaderboard</h3>
          <span class="muted">${allAssets.length} entries · Auto-scored by Quality, Reliability, Lineage & Freshness</span>
        </div>
        ${leaderboardHtml}
      </div>
    </div>
  `;

  listPane.querySelectorAll("[data-inspect]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = "assets";
      selectedId = btn.dataset.inspect;
      render();
    });
  });
  listPane.querySelectorAll("[data-validate]").forEach((btn) => {
    btn.addEventListener("click", () => mutate("/api/arena/validate", { id: btn.dataset.validate }));
  });
}

function render() {
  if (!state) return;
  const genes = state.genes || [];
  const capsules = state.capsules || [];
  const allAssets = [...genes, ...capsules];
  const totalReuses = allAssets.reduce((sum, a) => sum + (a.successCount || 0), 0);
  const linkCount = collectGraphData(allAssets).length;

  el("repo-status").textContent = state.syncRepoPath
    ? `Sync repo: ${state.syncRepoPath}`
    : `Auto-clone repo: ${state.config?.syncRepo || "JiaqiZhang-Dev/copilot-evo"}`;

  el("kpi-total").textContent = String(allAssets.length);
  el("kpi-breakdown").textContent = `${genes.length} Rules · ${capsules.length} Fixes`;
  el("kpi-team").textContent = String(state.counts?.teamAssets || 0);
  el("kpi-sub-team").textContent = state.config?.lastAutoPullAt
    ? `Synced ${formatLocalTime(state.config.lastAutoPullAt).slice(11, 16)}`
    : "Auto-syncs on start";
  el("kpi-reuses").textContent = String(totalReuses);
  el("kpi-events").textContent = String(state.counts?.events || 0);

  el("count-assets").textContent = String(allAssets.length);
  el("count-arena").textContent = String(allAssets.length);
  el("count-links").textContent = String(linkCount);
  el("count-events").textContent = String(state.counts?.events || 0);

  el("assets-toolbar").classList.toggle("hidden", activeTab !== "assets");
  el("rel-toolbar").classList.toggle("hidden", activeTab !== "relationships");
  el("events-toolbar").classList.toggle("hidden", activeTab !== "events");
  const isSinglePane = activeTab === "events" || activeTab === "arena";
  el("content").classList.toggle("single-pane", isSinglePane);
  el("content").classList.toggle("graph-pane", activeTab === "relationships");
  el("detail-pane").classList.toggle("hidden", isSinglePane);

  document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === activeTab));
  document.querySelectorAll(".chip[data-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.filter === activeFilter));
  document.querySelectorAll(".seg[data-kind]").forEach((btn) => btn.classList.toggle("active", btn.dataset.kind === activeKind));
  document.querySelectorAll(".chip[data-event-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.eventFilter === eventFilter));
  document.querySelectorAll(".chip[data-rel-mode]").forEach((btn) => btn.classList.toggle("active", btn.dataset.relMode === relMode));
  const repoBtn = el("chip-repo");
  if (repoBtn) {
    repoBtn.classList.toggle("active", repoFilter === "matching");
    repoBtn.textContent = state.currentRepo ? `Repo: ${state.currentRepo}` : "Global (*)";
  }

  const listPane = el("list-pane");

  if (activeTab === "arena") {
    renderArenaView(listPane, getAllAssets());
    return;
  }

  if (activeTab === "relationships") {
    renderRelationshipsView(listPane, getAllAssets());
    return;
  }

  if (activeTab === "events") {
    const events = getFilteredEvents();
    listPane.innerHTML = events.length
      ? `<div class="timeline">${events
          .map((ev) => {
            const meta = formatEventMeta(ev);
            const isWarn = meta.cls === "ev-warn";
            const sigs = (ev.signals || []).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
            return `
            <div class="event-row ${isWarn ? "is-warn" : ""}">
              <div class="event-top">
                <span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span>
                <span class="muted" title="${escapeHtml(ev.ts || "")}">${escapeHtml(formatLocalTime(ev.ts))}</span>
              </div>
              <div class="event-detail">${escapeHtml(meta.desc)}</div>
              ${sigs ? `<div class="badges">${sigs}</div>` : ""}
            </div>`;
          })
          .join("")}</div>`
      : `<div class="empty">No matching evolution events recorded.</div>`;
    return;
  }

  const items = getFilteredAssets();
  if (!items.length) {
    listPane.innerHTML = `<div class="empty">No experiences match the current filters.</div>`;
    renderDetail(null);
    return;
  }

  if (!items.some((i) => i.id === selectedId)) {
    selectedId = items[0].id;
    pendingDeleteId = "";
  }

  listPane.innerHTML = items
    .map((item) => {
      const kindCls = item.type === "Capsule" ? "kind-capsule" : "kind-gene";
      const scopeClass = item.scope === "team" ? "scope-team" : "";
      const sigs = (item.signals || []).slice(0, 4).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
      const fixClass = item.type === "Capsule" ? "card-fix" : "";
      return `
      <div class="card ${fixClass} ${item.id === selectedId ? "selected" : ""}" data-id="${escapeHtml(item.id)}">
        <div class="card-head">
          <div class="card-title-wrap">
            <span class="badge ${kindCls}">${kindLabel(item.type)}</span>
            <span class="card-title">${escapeHtml(item.title)}</span>
          </div>
          <div class="card-badges">
            ${item.gdiScore ? `<span class="badge gdi-badge">Score ${item.gdiScore}</span>` : ""}
            <span class="badge">${item.successCount || 0} reuses</span>
            ${item.failureCount ? `<span class="badge ev-warn">${item.gdiBreakdown?.winRate ?? 100}% win</span>` : ""}
            <span class="badge ${scopeClass}">${escapeHtml(item.scope || "local")}</span>
            ${item.repoScope && item.repoScope !== "*" ? `<span class="badge">${escapeHtml(item.repoScope)}</span>` : ""}
          </div>
        </div>
        <div class="card-summary">${escapeHtml(item.summary)}</div>
        <div class="badges">${sigs}</div>
      </div>`;
    })
    .join("");

  listPane.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedId = card.dataset.id;
      pendingDeleteId = "";
      render();
    });
  });

  const selected = items.find((i) => i.id === selectedId) || items[0];
  renderDetail(selected);
}

async function loadState(applyServerView = false) {
  const res = await fetch("/api/state", { cache: "no-store" });
  state = await res.json();
  if (applyServerView && state.viewState) {
    activeTab = state.viewState.tab || activeTab;
    activeFilter = state.viewState.filter || activeFilter;
    if (state.viewState.assetId) selectedId = state.viewState.assetId;
  }
  render();
}

async function mutate(endpoint, body) {
  showBanner("");
  const buttons = [el("btn-pull")].filter(Boolean);
  buttons.forEach((b) => (b.disabled = true));
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
      showBanner(`Pulled ${data.imported || 0} new and ${data.updated || 0} updated team experience(s).`);
    } else if (endpoint === "/api/assets/promote") {
      showBanner(`Promoted ${data.asset?.id || "experience"}.`);
    } else if (endpoint === "/api/assets/promote-team") {
      if (data.pushed) {
        showBanner(`Shared ${data.asset?.id || "experience"} to the team repository.`);
      } else if (data.syncError) {
        showBanner(`Marked ${data.asset?.id || "experience"} as team, but Git push failed: ${data.syncError}`, true);
      } else {
        showBanner(`Shared ${data.asset?.id || "experience"} as team experience.`);
      }
    } else if (endpoint === "/api/assets/feedback") {
      showBanner(`Updated ${data.asset?.id || "asset"} (GDI ${data.gdiScore ?? "-"}).`);
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
    await loadState(false);
  } catch (err) {
    showBanner(err.message, true);
  } finally {
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

  document.querySelectorAll(".chip[data-event-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      eventFilter = btn.dataset.eventFilter;
      render();
    });
  });

  document.querySelectorAll(".chip[data-rel-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      relMode = btn.dataset.relMode;
      render();
    });
  });

  el("chip-repo")?.addEventListener("click", () => {
    repoFilter = repoFilter === "matching" ? "all" : "matching";
    render();
  });

  el("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });

  el("btn-pull")?.addEventListener("click", () => mutate("/api/sync/pull", {}));

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
