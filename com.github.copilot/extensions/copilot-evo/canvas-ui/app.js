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
let arenaLeftId = "";
let arenaRightId = "";

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
  return [...(state.genes || []), ...(state.capsules || [])].sort((a, b) => (b.gdiScore || 0) - (a.gdiScore || 0));
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

function formatEventMeta(ev) {
  switch (ev.event) {
    case "solidify":
      return { label: "Solidified", cls: "ev-ok", desc: `${ev.assetType || "Asset"}: ${ev.assetId || ""}` };
    case "sync_push":
      return { label: "Team Push", cls: "ev-ok", desc: `Synced ${ev.genesCount || 0} Genes · ${ev.capsulesCount || 0} Capsules` };
    case "sync_pull":
      return { label: "Team Pull", cls: "ev-ok", desc: `Imported ${ev.imported || 0} team asset(s)` };
    case "promote":
    case "promote_team":
      return { label: "Promoted", cls: "ev-ok", desc: `${ev.assetType || "Asset"}: ${ev.assetId || ""}` };
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
      return { label: "Arena Pass", cls: "ev-ok", desc: `Validation passed for ${ev.assetId || ""}` };
    case "validation_fail":
      return { label: "Arena Fail", cls: "ev-warn", desc: `Validation failed for ${ev.assetId || ""}` };
    case "delete":
      return { label: "Deleted", cls: "", desc: `Removed ${ev.assetId || ""}` };
    case "tool_failure":
      return { label: "Signal Captured", cls: "ev-warn", desc: `Tool ${ev.toolName || "unknown"} failed (observed for learning)` };
    default:
      return { label: ev.event || "Event", cls: "", desc: ev.assetId || ev.toolName || "" };
  }
}

function renderDetail(item, isCandidate = false) {
  const pane = el("detail-pane");
  if (!item) {
    pane.innerHTML = `<div class="empty">Select a Gene or Capsule to inspect its signals, steps, and validation evidence.</div>`;
    return;
  }

  const kindCls = item.type === "Capsule" ? "kind-capsule" : "kind-gene";
  const signals = (item.signals || []).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
  const strategy = (item.strategy || []).length
    ? `<div class="section-label">Strategy Steps</div><ol class="steps">${item.strategy
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join("")}</ol>`
    : "";
  const solution = item.solution
    ? `<div class="section-label">Verified Solution</div><p class="detail-box">${escapeHtml(item.solution)}</p>`
    : "";
  const guardrail = item.guardrail?.reason
    ? `<div class="section-label">Guardrail</div><p class="detail-box">${escapeHtml(item.guardrail.reason)}</p>`
    : "";
  const validation = (item.validation || []).length
    ? `<div class="section-label">Validation Commands</div><p class="detail-box code-box">${escapeHtml(item.validation.join("\n"))}</p>`
    : "";

  const promoteCandidateBtn = isCandidate
    ? `<button class="btn btn-primary" data-promote="${escapeHtml(item.id)}" type="button">Promote</button>`
    : "";
  const promoteTeamBtn =
    !isCandidate && item.scope === "local"
      ? `<button class="btn" data-promote-team="${escapeHtml(item.id)}" type="button">Share to Team</button>`
      : "";
  const copyBtn = `<button class="btn" data-copy="${escapeHtml(item.id)}" type="button">Copy JSON</button>`;

  const rel = item.relationships || {};
  const relLinks = [];
  if (rel.gene) relLinks.push({ role: "Gene", item: rel.gene });
  if (rel.parent) relLinks.push({ role: "Parent", item: rel.parent });
  if (rel.supersedes) relLinks.push({ role: "Supersedes", item: rel.supersedes });
  for (const child of rel.children || []) relLinks.push({ role: child.type === "Capsule" ? "Capsule" : "Derived", item: child });
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
      <div>
        <h2 class="detail-title">${escapeHtml(item.title)}</h2>
        <div class="detail-id">
          <span class="badge ${kindCls}">${escapeHtml((item.type || "Gene").toUpperCase())}</span>
          <span class="badge gdi-badge">GDI ${escapeHtml(String(item.gdiScore ?? "-"))}</span>
          <span class="badge">${escapeHtml(item.repoScope && item.repoScope !== "*" ? item.repoScope : "global (*)")}</span>
          <span>${escapeHtml(item.id)}</span> · <span>${escapeHtml(item.scope || "local")}</span>
        </div>
      </div>
      <div class="actions">${promoteCandidateBtn}${promoteTeamBtn}${copyBtn}${deleteControl}</div>
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
    <p class="muted">Reuses: ${item.successCount || 0} · Failures: ${item.failureCount || 0} · Source: ${escapeHtml(item.sourceProject || "bundled")} · Updated: ${escapeHtml(item.updatedAt || "bundled")}</p>
  `;

  pane.querySelector("[data-promote]")?.addEventListener("click", () => mutate("/api/assets/promote", { id: item.id }));
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
    listPane.innerHTML = `<div class="empty">No assets available to map relationships.</div>`;
    renderDetail(null);
    return;
  }
  if (!allAssets.some((a) => a.id === selectedId)) {
    selectedId = allAssets[0].id;
  }

  const genes = allAssets.filter((a) => a.type !== "Capsule");
  const capsules = allAssets.filter((a) => a.type === "Capsule");
  const edges = collectGraphData(allAssets);

  const nodeW = 195;
  const nodeH = 48;
  const colX = capsules.length ? [16, 250] : [16];
  const rows = Math.max(genes.length, capsules.length, 1);
  const svgH = Math.max(140, rows * 68 + 20);
  const svgW = capsules.length ? 465 : 240;

  const positions = new Map();
  genes.forEach((g, idx) => positions.set(g.id, { x: colX[0], y: 14 + idx * 68, asset: g }));
  capsules.forEach((c, idx) => positions.set(c.id, { x: colX[1], y: 14 + idx * 68, asset: c }));

  const edgeSvg = edges
    .map((e) => {
      const p1 = positions.get(e.from);
      const p2 = positions.get(e.to);
      if (!p1 || !p2) return "";
      const x1 = p1.x + (p1.x === p2.x ? nodeW : nodeW);
      const y1 = p1.y + nodeH / 2;
      const x2 = p2.x + (p1.x === p2.x ? nodeW : 0);
      const y2 = p2.y + nodeH / 2;
      const isActive = e.from === selectedId || e.to === selectedId;
      const stroke =
        e.kind === "signal"
          ? "var(--muted)"
          : e.kind === "supersedes"
          ? "var(--warn)"
          : "var(--accent)";
      const dash = e.kind === "signal" ? 'stroke-dasharray="4 3"' : "";
      const opacity = isActive ? "0.95" : "0.4";
      const pathD =
        p1.x === p2.x
          ? `M ${p1.x + nodeW} ${y1} C ${p1.x + nodeW + 36} ${y1}, ${p2.x + nodeW + 36} ${y2}, ${p2.x + nodeW} ${y2}`
          : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
      return `<path d="${pathD}" fill="none" stroke="${stroke}" stroke-width="${isActive ? 2 : 1.3}" stroke-opacity="${opacity}" ${dash} />`;
    })
    .join("");

  const nodeSvg = allAssets
    .map((a) => {
      const pos = positions.get(a.id);
      if (!pos) return "";
      const selected = a.id === selectedId;
      const isCap = a.type === "Capsule";
      const stroke = selected ? "var(--accent)" : "var(--border)";
      const fill = selected ? "var(--accent-muted)" : "var(--bg)";
      const badgeColor = isCap ? "var(--accent)" : "var(--gene)";
      const shortTitle = (a.title || a.id).slice(0, 22) + ((a.title || "").length > 22 ? "…" : "");
      return `
      <g class="graph-node" data-node-id="${escapeHtml(a.id)}">
        <rect x="${pos.x}" y="${pos.y}" width="${nodeW}" height="${nodeH}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${selected ? 2 : 1}" />
        <text x="${pos.x + 10}" y="${pos.y + 18}" fill="${badgeColor}" font-size="10" font-weight="700" font-family="monospace">${isCap ? "CAPSULE" : "GENE"} · GDI ${a.gdiScore || "-"}</text>
        <text x="${pos.x + 10}" y="${pos.y + 35}" fill="var(--text)" font-size="11.5" font-weight="600">${escapeHtml(shortTitle)}</text>
      </g>`;
    })
    .join("");

  listPane.innerHTML = `
    <div class="graph-legend">
      <span>● Green: Gene</span>
      <span>● Blue: Capsule</span>
      <span>— Solid: Lineage (geneId / parentId / supersedes)</span>
      <span>-- Dashed: Shared Signals (${edges.filter((e) => e.kind === "signal").length})</span>
    </div>
    <div class="graph-wrap">
      <svg class="graph-svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">
        ${edgeSvg}
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

  const selected = allAssets.find((a) => a.id === selectedId) || allAssets[0];
  renderDetail(selected, false);
}

function renderArenaView(listPane, allAssets) {
  if (!allAssets.length) {
    listPane.innerHTML = `<div class="empty">No Genes or Capsules available for evaluation yet.</div>`;
    return;
  }

  if (!allAssets.some((a) => a.id === arenaLeftId)) arenaLeftId = allAssets[0].id;
  if (!allAssets.some((a) => a.id === arenaRightId) || arenaRightId === arenaLeftId) {
    const alt = allAssets.find((a) => a.id !== arenaLeftId);
    arenaRightId = alt ? alt.id : allAssets[0].id;
  }

  const left = allAssets.find((a) => a.id === arenaLeftId) || allAssets[0];
  const right = allAssets.find((a) => a.id === arenaRightId) || allAssets[0];
  const leftWinner = (left.gdiScore || 0) >= (right.gdiScore || 0);

  const renderDuelCard = (item, isWinner) => {
    const b = item.gdiBreakdown || {};
    const dims = [
      ["Quality (35%)", b.quality || 0],
      ["Reliability (30%)", b.reliability || 0],
      ["Lineage (20%)", b.lineage || 0],
      ["Freshness (15%)", b.freshness || 0],
    ];
    return `
      <div class="duel-card ${isWinner && left.id !== right.id ? "winner" : ""}">
        <div class="card-head" style="margin-bottom:6px">
          <span class="card-title">${escapeHtml(item.title)}</span>
          <span class="badge gdi-badge">${isWinner && left.id !== right.id ? "Winner · " : ""}GDI ${item.gdiScore || 0}</span>
        </div>
        <div class="muted" style="margin-bottom:8px">Win rate: ${b.winRate ?? 100}% · Reuses: ${item.successCount || 0} · Failures: ${item.failureCount || 0}</div>
        ${dims
          .map(
            ([label, val]) => `
          <div class="dim-row">
            <span class="muted">${label}</span>
            <div class="bar-track"><div class="bar-fill ${item.type !== "Capsule" ? "gene" : ""}" style="width:${val}%"></div></div>
            <span class="code-box">${val}</span>
          </div>`
          )
          .join("")}
      </div>`;
  };

  const optionsHtml = (selected) =>
    allAssets
      .map(
        (a) =>
          `<option value="${escapeHtml(a.id)}" ${a.id === selected ? "selected" : ""}>[${a.type}] ${escapeHtml(a.title)} (${a.gdiScore})</option>`
      )
      .join("");

  const leaderboardHtml = allAssets
    .map((item, idx) => {
      const b = item.gdiBreakdown || {};
      const kindCls = item.type === "Capsule" ? "kind-capsule" : "kind-gene";
      const hasVal = Array.isArray(item.validation) && item.validation.length > 0;
      return `
      <div class="lb-row">
        <div class="lb-top">
          <div class="card-title-wrap">
            <span class="badge">#${idx + 1}</span>
            <span class="tier-badge tier-${escapeHtml(b.tier || "B")}">${escapeHtml(b.tier || "B")}</span>
            <span class="badge ${kindCls}">${escapeHtml((item.type || "Gene").toUpperCase())}</span>
            <span class="card-title">${escapeHtml(item.title)}</span>
          </div>
          <div class="actions">
            <span class="badge gdi-badge">GDI ${item.gdiScore || 0}</span>
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
          <h3>Head-to-Head Evaluation</h3>
          <span class="muted">Compare strategies across 4 GDI dimensions</span>
        </div>
        <div class="match-pickers">
          <select id="arena-left" class="select-box">${optionsHtml(left.id)}</select>
          <span class="vs-pill">VS</span>
          <select id="arena-right" class="select-box">${optionsHtml(right.id)}</select>
        </div>
        <div class="duel-grid">
          ${renderDuelCard(left, leftWinner)}
          ${renderDuelCard(right, !leftWinner)}
        </div>
      </div>
      <div class="arena-section">
        <div class="arena-header">
          <h3>GDI Competitive Leaderboard</h3>
          <span class="muted">${allAssets.length} entries · Top tier ${escapeHtml(allAssets[0]?.gdiBreakdown?.tier || "-")}</span>
        </div>
        ${leaderboardHtml}
      </div>
    </div>
  `;

  el("arena-left")?.addEventListener("change", (e) => {
    arenaLeftId = e.target.value;
    render();
  });
  el("arena-right")?.addEventListener("change", (e) => {
    arenaRightId = e.target.value;
    render();
  });
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
  el("kpi-breakdown").textContent = `${genes.length} Genes · ${capsules.length} Capsules`;
  el("kpi-team").textContent = String(state.counts?.teamAssets || 0);
  el("kpi-reuses").textContent = String(totalReuses);
  el("kpi-events").textContent = String(state.counts?.events || 0);

  el("count-assets").textContent = String(allAssets.length);
  el("count-arena").textContent = String(allAssets.length);
  el("count-links").textContent = String(linkCount);
  el("count-candidates").textContent = String(state.candidates?.length || 0);
  el("count-events").textContent = String(state.counts?.events || 0);

  el("assets-toolbar").classList.toggle("hidden", activeTab !== "assets");
  el("rel-toolbar").classList.toggle("hidden", activeTab !== "relationships");
  el("events-toolbar").classList.toggle("hidden", activeTab !== "events");
  const isSinglePane = activeTab === "events" || activeTab === "arena";
  el("content").classList.toggle("single-pane", isSinglePane);
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
      ? events
          .map((ev) => {
            const meta = formatEventMeta(ev);
            const sigs = (ev.signals || []).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
            return `
            <div class="event-row">
              <div class="event-top">
                <span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span>
                <span class="muted">${escapeHtml(ev.ts || "")}</span>
              </div>
              <div class="event-detail">${escapeHtml(meta.desc)}</div>
              ${sigs ? `<div class="badges">${sigs}</div>` : ""}
            </div>`;
          })
          .join("")
      : `<div class="empty">No matching evolution events recorded.</div>`;
    return;
  }

  const items = activeTab === "candidates" ? state.candidates || [] : getFilteredAssets();
  if (!items.length) {
    listPane.innerHTML = `<div class="empty">No items match the current filters.</div>`;
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
      return `
      <div class="card ${item.id === selectedId ? "selected" : ""}" data-id="${escapeHtml(item.id)}">
        <div class="card-head">
          <div class="card-title-wrap">
            <span class="badge ${kindCls}">${escapeHtml((item.type || "Gene").toUpperCase())}</span>
            <span class="card-title">${item.pinned ? "📌 " : ""}${escapeHtml(item.title)}</span>
          </div>
          <div class="card-badges">
            ${item.gdiScore ? `<span class="badge gdi-badge">GDI ${item.gdiScore}</span>` : ""}
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
  renderDetail(selected, activeTab === "candidates");
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
  const buttons = [el("btn-pull"), el("btn-push")];
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
    } else if (endpoint === "/api/sync/push") {
      showBanner(data.pushed ? `Pushed ${data.genesCount} Genes and ${data.capsulesCount} Capsules.` : data.message);
    } else if (endpoint === "/api/sync/pull") {
      showBanner(`Pulled ${data.imported || 0} new team asset(s).`);
    } else if (endpoint === "/api/assets/promote") {
      showBanner(`Promoted candidate ${data.asset?.id || ""}.`);
    } else if (endpoint === "/api/assets/promote-team") {
      showBanner(`Marked ${data.asset?.id || "asset"} as team scope. Click Push Team to sync.`);
    } else if (endpoint === "/api/assets/feedback") {
      showBanner(`Updated ${data.asset?.id || "asset"} (GDI ${data.gdiScore ?? "-"}).`);
    } else if (endpoint === "/api/arena/validate") {
      showBanner(`Validation ${data.passed ? "PASSED" : "FAILED"} for ${data.assetId}.`, !data.passed);
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

  el("btn-refresh")?.addEventListener("click", () => loadState(false));
  el("btn-pull").addEventListener("click", () => mutate("/api/sync/pull", {}));
  el("btn-push").addEventListener("click", () => mutate("/api/sync/push", {}));

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
