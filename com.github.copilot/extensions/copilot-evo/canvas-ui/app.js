let state = null;
let canvasToken = "";
let activeTab = "assets";
let activeFilter = "all";
let searchQuery = "";
let selectedId = "";

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
    if (activeFilter !== "all" && item.scope !== activeFilter) return false;
    if (!q) return true;
    const text = `${item.id} ${item.title} ${item.summary} ${(item.signals || []).join(" ")}`.toLowerCase();
    return text.includes(q);
  });
}

function renderDetail(item, isCandidate = false) {
  const pane = el("detail-pane");
  if (!item) {
    pane.innerHTML = `<div class="empty">Select a Gene or Capsule to preview its full details.</div>`;
    return;
  }
  const signals = (item.signals || []).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
  const strategy = (item.strategy || []).length
    ? `<div class="section-label">Strategy</div><ol class="steps">${item.strategy
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join("")}</ol>`
    : "";
  const solution = item.solution
    ? `<div class="section-label">Solution</div><p class="detail-box">${escapeHtml(item.solution)}</p>`
    : "";
  const validation = (item.validation || []).length
    ? `<div class="section-label">Validation</div><p class="detail-box">${escapeHtml(item.validation.join(" | "))}</p>`
    : "";

  const actionBtn = isCandidate
    ? `<button class="btn btn-primary" data-promote="${escapeHtml(item.id)}" type="button">Promote</button>`
    : "";
  const deleteBtn =
    item.scope === "starter"
      ? ""
      : `<button class="btn btn-danger" data-delete="${escapeHtml(item.id)}" type="button">Delete</button>`;

  pane.innerHTML = `
    <div class="detail-head">
      <div>
        <h2 class="detail-title">${escapeHtml(item.title)}</h2>
        <div class="detail-id">${escapeHtml(item.type)} · ${escapeHtml(item.id)} · ${escapeHtml(item.scope || "local")}</div>
      </div>
      <div class="actions">${actionBtn}${deleteBtn}</div>
    </div>
    <div class="badges">${signals}</div>
    <div class="section-label">Summary</div>
    <p class="detail-box">${escapeHtml(item.summary)}</p>
    ${solution}
    ${strategy}
    ${validation}
    <div class="section-label">Metadata</div>
    <p class="muted">Successes: ${item.successCount || 0} · Updated: ${escapeHtml(item.updatedAt || "bundled")}</p>
  `;

  pane.querySelector("[data-promote]")?.addEventListener("click", () => mutate("/api/assets/promote", { id: item.id }));
  pane.querySelector("[data-delete]")?.addEventListener("click", () => mutate("/api/assets/delete", { id: item.id }));
}

function render() {
  if (!state) return;
  el("repo-status").textContent = state.syncRepoPath
    ? `Sync repo: ${state.syncRepoPath}`
    : `Auto-clone repo: ${state.config?.syncRepo || "JiaqiZhang-Dev/copilot-evo"}`;
  el("count-assets").textContent = String((state.genes?.length || 0) + (state.capsules?.length || 0));
  el("count-candidates").textContent = String(state.candidates?.length || 0);
  el("count-events").textContent = String(state.counts?.events || 0);

  el("toolbar").classList.toggle("hidden", activeTab !== "assets");
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === activeTab);
  });
  document.querySelectorAll(".chip").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === activeFilter);
  });

  const listPane = el("list-pane");

  if (activeTab === "events") {
    const events = state.events || [];
    listPane.innerHTML = events.length
      ? events
          .map(
            (ev) => `
        <div class="event-row">
          <div class="event-top">
            <span>${escapeHtml(ev.event || "event")}</span>
            <span class="muted">${escapeHtml(ev.ts || "")}</span>
          </div>
          <div class="muted">${escapeHtml(ev.assetId || ev.toolName || "")} ${
              ev.signals?.length ? `· ${escapeHtml(ev.signals.join(", "))}` : ""
            }</div>
        </div>`
          )
          .join("")
      : `<div class="empty">No evolution events recorded yet.</div>`;
    renderDetail(null);
    return;
  }

  const items = activeTab === "candidates" ? state.candidates || [] : getFilteredAssets();
  if (!items.length) {
    listPane.innerHTML = `<div class="empty">No items match the current view.</div>`;
    renderDetail(null);
    return;
  }

  if (!items.some((i) => i.id === selectedId)) {
    selectedId = items[0].id;
  }

  listPane.innerHTML = items
    .map((item) => {
      const scopeClass = item.scope === "team" ? "scope-team" : "";
      const sigs = (item.signals || []).slice(0, 4).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
      return `
      <div class="card ${item.id === selectedId ? "selected" : ""}" data-id="${escapeHtml(item.id)}">
        <div class="card-head">
          <span class="card-title">${escapeHtml(item.title)}</span>
          <span class="badge ${scopeClass}">${escapeHtml(item.type)} · ${escapeHtml(item.scope || "local")}</span>
        </div>
        <div class="card-summary">${escapeHtml(item.summary)}</div>
        <div class="badges">${sigs}</div>
      </div>`;
    })
    .join("");

  listPane.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedId = card.dataset.id;
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
      showBanner(`Promoted ${data.asset?.id || "candidate"}.`);
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
      render();
    });
  });

  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
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
