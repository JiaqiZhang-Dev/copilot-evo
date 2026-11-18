let state = null;
let canvasToken = "";
let activeTab = "assets";
let activeFilter = "all";
let activeKind = "all";
let eventFilter = "all";
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
  return [...(state.genes || []), ...(state.capsules || [])];
}

function getFilteredAssets() {
  const q = searchQuery.trim().toLowerCase();
  return getAllAssets().filter((item) => {
    if (activeKind !== "all" && item.type !== activeKind) return false;
    if (activeFilter !== "all" && item.scope !== activeFilter) return false;
    if (!q) return true;
    const text = `${item.id} ${item.title} ${item.summary} ${item.solution || ""} ${(item.signals || []).join(" ")}`.toLowerCase();
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
    <div class="section-label">Provenance</div>
    <p class="muted">Reuses: ${item.successCount || 0} · Source: ${escapeHtml(item.sourceProject || "bundled")} · Updated: ${escapeHtml(item.updatedAt || "bundled")}</p>
  `;

  pane.querySelector("[data-promote]")?.addEventListener("click", () => mutate("/api/assets/promote", { id: item.id }));
  pane.querySelector("[data-promote-team]")?.addEventListener("click", () => mutate("/api/assets/promote-team", { id: item.id }));
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

function render() {
  if (!state) return;
  const genes = state.genes || [];
  const capsules = state.capsules || [];
  const allAssets = [...genes, ...capsules];
  const totalReuses = allAssets.reduce((sum, a) => sum + (a.successCount || 0), 0);

  el("repo-status").textContent = state.syncRepoPath
    ? `Sync repo: ${state.syncRepoPath}`
    : `Auto-clone repo: ${state.config?.syncRepo || "JiaqiZhang-Dev/copilot-evo"}`;

  el("kpi-total").textContent = String(allAssets.length);
  el("kpi-breakdown").textContent = `${genes.length} Genes · ${capsules.length} Capsules`;
  el("kpi-team").textContent = String(state.counts?.teamAssets || 0);
  el("kpi-reuses").textContent = String(totalReuses);
  el("kpi-events").textContent = String(state.counts?.events || 0);

  el("count-assets").textContent = String(allAssets.length);
  el("count-candidates").textContent = String(state.candidates?.length || 0);
  el("count-events").textContent = String(state.counts?.events || 0);

  el("assets-toolbar").classList.toggle("hidden", activeTab !== "assets");
  el("events-toolbar").classList.toggle("hidden", activeTab !== "events");
  el("content").classList.toggle("single-pane", activeTab === "events");
  el("detail-pane").classList.toggle("hidden", activeTab === "events");

  document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === activeTab));
  document.querySelectorAll(".chip[data-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.filter === activeFilter));
  document.querySelectorAll(".seg[data-kind]").forEach((btn) => btn.classList.toggle("active", btn.dataset.kind === activeKind));
  document.querySelectorAll(".chip[data-event-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.eventFilter === eventFilter));

  const listPane = el("list-pane");

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
            <span class="card-title">${escapeHtml(item.title)}</span>
          </div>
          <div class="card-badges">
            <span class="badge ${scopeClass}">${escapeHtml(item.scope || "local")}</span>
            ${item.successCount ? `<span class="badge">${item.successCount}x</span>` : ""}
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

  el("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });

  el("btn-pull").addEventListener("click", () => mutate("/api/sync/pull", {}));
  el("btn-push").addEventListener("click", () => mutate("/api/sync/push", {}));

  await loadState(true);

  const es = new EventSource("/api/events");
  es.addEventListener("update", () => loadState(true));
}

init();
