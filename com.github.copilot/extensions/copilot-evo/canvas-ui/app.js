let state = null;
let canvasToken = "";
let activeTab = "assets";
let activeFilter = "all";
let activeKind = "all";
let repoScopeFilter = ""; // "" | "cross" | "repo"
let contribMode = "author";
let eventFilter = "all";
let eventSessionFilter = "";
let eventSearchQuery = "";
let eventDisplayLimit = 25;
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

function normalizeKind(type) {
  const v = String(type || "").toLowerCase();
  if (v === "fix") return "Fix";
  if (v === "knowledge") return "Knowledge";
  return "Rule";
}

function getAllAssets() {
  if (!state) return [];
  return [...(state.knowledge || []), ...(state.rules || []), ...(state.fixes || [])].sort((a, b) => {
    const scoreDiff = (b.gdiScore || 0) - (a.gdiScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const reuseDiff = (b.successCount || 0) - (a.successCount || 0);
    if (reuseDiff !== 0) return reuseDiff;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

function isRepoSpecificMatch(item, curRepo) {
  const r = (item.repoScope || "*").toLowerCase();
  if (r === "*") return false;
  return !curRepo || r === curRepo;
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
    if (repoScopeFilter === "cross" && (item.repoScope || "*") !== "*") return false;
    if (repoScopeFilter === "repo" && !isRepoSpecificMatch(item, curRepo)) return false;
    const itemType = normalizeKind(item.type);
    if (activeKind !== "all" && itemType !== activeKind) return false;
    if (!q) return true;
    const text = `${item.id} ${item.title} ${item.summary} ${item.solution || ""} ${item.repoScope || ""} ${(item.signals || []).join(" ")}`.toLowerCase();
    return text.includes(q);
  });
}

function getFilteredEvents() {
  let events = state?.events || [];
  if (eventFilter === "signals") {
    events = events.filter((ev) => ev.event === "tool_failure");
  } else if (eventFilter === "reuses") {
    events = events.filter((ev) =>
      ["recall", "auto_success", "auto_failure", "validation_pass", "validation_fail", "feedback_upvote", "feedback_downvote"].includes(ev.event)
    );
  } else if (eventFilter === "evolution") {
    events = events.filter((ev) =>
      ["solidify", "promote_team", "sync_push", "sync_pull", "sync_scores", "delete"].includes(ev.event)
    );
  }
  const targetSession =
    eventSessionFilter === "current" ? state?.currentSession?.sessionId || "" : eventSessionFilter;
  if (targetSession) {
    events = events.filter((ev) => ev.sessionId === targetSession);
  }
  const q = eventSearchQuery.trim().toLowerCase();
  if (q) {
    events = events.filter((ev) => {
      const hay = `${ev.event || ""} ${ev.sessionName || ""} ${ev.sessionId || ""} ${ev.repo || ""} ${ev.project || ""} ${ev.toolName || ""} ${ev.assetId || ""} ${(ev.assetIds || []).join(" ")} ${(ev.assetTitles || []).join(" ")} ${(ev.signals || []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
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

function formatRelativeTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function displayTypeWord(type) {
  return normalizeKind(type);
}

function formatRecallTrigger(ev) {
  if (ev.trigger === "session_start") return "on session start";
  if (ev.trigger === "tool_failure") return `after ${ev.toolName || "tool"} failure`;
  if (ev.trigger === "subagent") return `in ${ev.toolName || "subagent"} subagent`;
  if (ev.trigger === "search") return "via search";
  return "on prompt";
}

function formatEventMeta(ev) {
  switch (ev.event) {
    case "recall": {
      const names = (ev.assetTitles && ev.assetTitles.length ? ev.assetTitles : ev.assetIds || []).filter(Boolean);
      const where = ev.repo || ev.project || "session";
      return {
        label: "Recalled",
        cls: "ev-ok",
        desc: `Applied ${formatRecallTrigger(ev)} in ${where}${names.length ? ` (${names.length})` : ""}`,
      };
    }
    case "solidify":
      return { label: "Solidified", cls: "ev-ok", desc: `${displayTypeWord(ev.assetType)}: ${ev.assetId || ""}` };
    case "sync_push":
      return {
        label: "Team Push",
        cls: "ev-ok",
        desc: `Synced ${ev.knowledgeCount ?? 0} Knowledge · ${ev.rulesCount ?? ev.genesCount ?? 0} Rules · ${ev.fixesCount ?? ev.capsulesCount ?? 0} Fixes`,
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
  const k = normalizeKind(type);
  return k === "Fix" ? "FIX" : k === "Knowledge" ? "KNOWLEDGE" : "RULE";
}

function renderScoreRing(score, titleText = "") {
  const val = Math.max(0, Math.min(100, Number(score || 0)));
  const r = 17;
  const circ = 2 * Math.PI * r;
  const dash = ((val / 100) * circ).toFixed(1);
  const svg = `
    <svg class="score-ring" viewBox="0 0 44 44" aria-label="Score ${val}">
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="rgba(9, 105, 218, 0.15)" stroke-width="3.5" />
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--accent)" stroke-width="3.5"
        stroke-linecap="round" stroke-dasharray="${dash} ${circ.toFixed(1)}" transform="rotate(-90 22 22)" />
      <text x="22" y="25.5" text-anchor="middle" fill="var(--accent)" font-size="11" font-weight="700" font-family="Consolas, monospace">${Math.round(val)}</text>
    </svg>`;
  return titleText
    ? `<span class="score-ring-wrap" title="${escapeHtml(titleText)}">${svg}</span>`
    : svg;
}

function buildScoreTooltips(item) {
  const b = item.gdiBreakdown || {};
  const q = b.quality ?? 0;
  const rel = b.reliability ?? 0;
  const lin = b.lineage ?? 0;
  const fr = b.freshness ?? 0;
  const pinnedLine = item.pinned ? "\n+ Pinned bonus (+15)" : "";
  const totalTip = [
    `Score ${item.gdiScore ?? "-"} (Tier ${b.tier || "B"})`,
    `= Quality ${q}×35% (${(q * 0.35).toFixed(1)})`,
    `+ Reliability ${rel}×30% (${(rel * 0.3).toFixed(1)})`,
    `+ Lineage ${lin}×20% (${(lin * 0.2).toFixed(1)})`,
    `+ Freshness ${fr}×15% (${(fr * 0.15).toFixed(1)})${pinnedLine}`,
  ].join("\n");

  const kind = normalizeKind(item.type);
  const hasTitle = String(item.title || "").trim().length >= 8;
  const hasSummary = String(item.summary || "").trim().length >= 20;
  const hasSignals = Array.isArray(item.signals) && item.signals.length >= 2;
  const hasSteps =
    (Array.isArray(item.strategy) && item.strategy.length >= (kind === "Knowledge" ? 1 : 2)) ||
    String(item.solution || "").trim().length >= 15 ||
    (kind === "Knowledge" && String(item.summary || "").trim().length >= 60);
  const hasVal =
    (Array.isArray(item.validation) && item.validation.length > 0) ||
    (Array.isArray(item.references) && item.references.length > 0) ||
    (kind === "Knowledge" &&
      String(item.summary || "").trim().length >= 45 &&
      ((Array.isArray(item.strategy) && item.strategy.length >= 1) ||
        String(item.solution || "").trim().length >= 15));
  const qualityTip = [
    `Quality ${q}/100 (35% weight)`,
    `Base: 25`,
    `Title >=8 chars: ${hasTitle ? "+15" : "+0"}`,
    `Summary >=20 chars: ${hasSummary ? "+15" : "+0"}`,
    `>=2 Signals: ${hasSignals ? "+15" : "+0"}`,
    kind === "Knowledge"
      ? `Rich summary or takeaway: ${hasSteps ? "+15" : "+0"}`
      : `>=2 Steps or Solution: ${hasSteps ? "+15" : "+0"}`,
    kind === "Knowledge" && !item.validation?.length && !item.references?.length
      ? `Summary >=45 + takeaway: ${hasVal ? "+15" : "+0"}`
      : `Validation or evidence links: ${hasVal ? "+15" : "+0"}`,
  ].join("\n");

  const succ = Math.max(0, Number(item.successCount || 0));
  const fail = Math.max(0, Number(item.failureCount || 0));
  const recalls = Math.max(0, Number(item.recallCount || 0));
  const reliabilityTip = [
    `Reliability ${rel}/100 (30% weight)`,
    `Helpful uses: ${succ} (log2 growth, max 60)`,
    ...(recalls ? [`Recalled: ${recalls}`] : []),
    `Pass rate: ${b.winRate ?? 100}% (max 35, 20 if 0 runs)`,
    `Failures: ${fail} (-12 each, max -35)`,
    ...(item.priority ? [`Priority bonus: +${Math.min(10, Number(item.priority))}`] : []),
  ].join("\n");

  const scopeBase = item.scope === "team" ? 40 : item.scope === "starter" ? 30 : 20;
  const hasUpstream = Boolean(item.ruleId || item.parentId || item.supersedes);
  const hasChildren = Boolean(item.relationships?.children?.length);
  const lineageTip = [
    `Lineage ${lin}/100 (20% weight)`,
    `Scope (${item.scope || "local"}): +${scopeBase}`,
    `Upstream link: ${hasUpstream ? "+25" : "+0"}`,
    `Derived children: ${hasChildren ? "+25" : "+0"}`,
    `Pinned: ${item.pinned ? "+10" : "+0"}`,
  ].join("\n");

  const freshnessTip = [
    `Freshness ${fr}/100 (15% weight)`,
    item.updatedAt
      ? `100 / (1 + ageDays / 14)\nUpdated: ${formatLocalTime(item.updatedAt)}`
      : "Default 55 (no updatedAt timestamp)",
  ].join("\n");

  return { totalTip, qualityTip, reliabilityTip, lineageTip, freshnessTip };
}

function renderDetail(item) {
  const pane = el("detail-pane");
  if (!item) {
    pane.innerHTML = `<div class="empty">Select an Experience to inspect its signals, steps, and validation evidence.</div>`;
    return;
  }

  const itemKind = normalizeKind(item.type);
  const signals = (item.signals || []).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
  const stepsLabel = itemKind === "Knowledge" ? "Key Takeaways" : "Steps";
  const strategy = (item.strategy || []).length
    ? `<div class="section-label">${stepsLabel}</div><ol class="steps">${item.strategy
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join("")}</ol>`
    : "";
  const solution = item.solution
    ? `<div class="section-label">${itemKind === "Fix" ? "Verified Fix" : "Reference"}</div><p class="detail-box">${escapeHtml(item.solution)}</p>`
    : "";
  const guardrail = item.guardrail?.reason
    ? `<div class="section-label">Guardrail</div><p class="detail-box">${escapeHtml(item.guardrail.reason)}</p>`
    : "";
  const validation = (item.validation || []).length
    ? `<div class="section-label">Validation Commands</div><p class="detail-box code-box">${escapeHtml(item.validation.join("\n"))}</p>`
    : "";
  const references = Array.isArray(item.references)
    ? item.references.filter((r) => r?.url && /^https:\/\//i.test(r.url))
    : [];
  const evidenceHtml = references.length
    ? `<div class="section-label">Evidence &amp; Links</div><div class="link-list">${references
        .map(
          (r) =>
            `<a class="link-pill evidence-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(r.url)}">${escapeHtml(r.label || r.url)} ↗</a>`
        )
        .join("")}</div>`
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
  const repoText = item.repoScope && item.repoScope !== "*" ? item.repoScope : "Cross-repo";
  const refineHtml =
    item.scope !== "starter"
      ? `<div class="section-label">Refine with Copilot</div>
         <div class="refine-bar">
           <input id="refine-input" class="refine-input" type="text" placeholder="Tell Copilot how to update this experience..." />
           <button id="btn-refine" class="btn btn-primary" type="button">Refine</button>
         </div>`
      : "";
  const recallCount = Number(item.recallCount || 0);
  const noisyWarning =
    recallCount >= 5 && (item.successCount || 0) <= 1
      ? `<p class="detail-box">High recall count (${recallCount} recalls, ${item.successCount || 0} helpful) — consider narrowing signals or repoScope via Refine.</p>`
      : "";
  const provenanceParts = [
    item.author ? `Author: ${escapeHtml(item.author)}` : "",
    `Source: ${escapeHtml(item.sourceProject || "bundled")}`,
    ...(recallCount ? [`Recalled: ${recallCount}`] : []),
    `Updated: ${escapeHtml(item.updatedAt ? formatLocalTime(item.updatedAt) : "bundled")}`,
  ].filter(Boolean);

  const usageEvents = (state?.events || [])
    .filter(
      (ev) =>
        ["recall", "auto_success", "auto_failure", "validation_pass", "validation_fail"].includes(ev.event) &&
        (ev.assetId === item.id || (ev.assetIds || []).includes(item.id))
    )
    .slice(0, 5);
  const usageHtml = `<div class="section-label">Recent Usage</div>${
    usageEvents.length
      ? `<div class="usage-list">${usageEvents
          .map((ev) => {
            const actionText =
              ev.event === "recall"
                ? `Recalled ${formatRecallTrigger(ev)}`
                : ev.event === "auto_success"
                  ? "Verified reuse"
                  : ev.event === "validation_pass"
                    ? "Validation passed"
                    : ev.event === "validation_fail"
                      ? "Validation failed"
                      : "Feedback";
            const where = [ev.sessionName || (ev.sessionId ? ev.sessionId.slice(0, 8) : ""), ev.repo || ev.project || ""]
              .filter(Boolean)
              .join(" · ");
            return `<div class="usage-item"><span><strong>${escapeHtml(actionText)}</strong>${where ? ` in ${escapeHtml(where)}` : ""}</span><span>${escapeHtml(formatLocalTime(ev.ts))}</span></div>`;
          })
          .join("")}</div>`
      : `<p class="muted">No recall or verification events recorded yet.</p>`
  }`;

  const scoreTips = buildScoreTooltips(item);

  pane.innerHTML = `
    <div class="detail-head">
      <div class="detail-title-row">
        ${renderScoreRing(item.gdiScore, scoreTips.totalTip)}
        <div>
          <h2 class="detail-title">${escapeHtml(item.title)}</h2>
          <div class="detail-meta-line">
            <span class="detail-meta-pill">${escapeHtml(itemKind)}</span>
            <span>·</span>
            <span title="${escapeHtml(scoreTips.totalTip)}">Score ${escapeHtml(String(item.gdiScore ?? "-"))}</span>
            <span>·</span>
            <span>${item.successCount || 0} helpful</span>
            ${recallCount ? `<span>·</span><span>${recallCount} recalled</span>` : ""}
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
    ${noisyWarning}
    <div class="section-label">Trigger Signals</div>
    <div class="badges">${signals || '<span class="muted">None</span>'}</div>
    <div class="section-label">Summary</div>
    <p class="detail-box">${escapeHtml(item.summary)}</p>
    ${solution}
    ${strategy}
    ${guardrail}
    ${validation}
    ${evidenceHtml}
    <div class="section-label" title="${escapeHtml(scoreTips.totalTip)}">Score Breakdown · Tier ${escapeHtml(item.gdiBreakdown?.tier || "B")} · ${escapeHtml(String(item.gdiBreakdown?.winRate ?? 100))}% Pass Rate</div>
    <div class="detail-breakdown">
      <div class="mini-dim" title="${escapeHtml(scoreTips.qualityTip)}">Quality <strong>${item.gdiBreakdown?.quality ?? 0}</strong><progress class="score-bar" max="100" value="${Number(item.gdiBreakdown?.quality ?? 0)}"></progress></div>
      <div class="mini-dim" title="${escapeHtml(scoreTips.reliabilityTip)}">Reliability <strong>${item.gdiBreakdown?.reliability ?? 0}</strong><progress class="score-bar" max="100" value="${Number(item.gdiBreakdown?.reliability ?? 0)}"></progress></div>
      <div class="mini-dim" title="${escapeHtml(scoreTips.lineageTip)}">Lineage <strong>${item.gdiBreakdown?.lineage ?? 0}</strong><progress class="score-bar" max="100" value="${Number(item.gdiBreakdown?.lineage ?? 0)}"></progress></div>
      <div class="mini-dim" title="${escapeHtml(scoreTips.freshnessTip)}">Freshness <strong>${item.gdiBreakdown?.freshness ?? 0}</strong><progress class="score-bar" max="100" value="${Number(item.gdiBreakdown?.freshness ?? 0)}"></progress></div>
    </div>
    ${usageHtml}
    ${lineageHtml}
    <div class="section-label">Provenance</div>
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
    for (const s of a.relationships?.sharedSignals || []) {
      if (!idSet.has(s.id)) continue;
      const pairKey = [a.id, s.id].sort().join("|");
      if (seenShared.has(pairKey)) continue;
      seenShared.add(pairKey);
      edges.push({ from: a.id, to: s.id, kind: "signal", label: s.overlap.join(", ") });
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

  const padX = 88;
  const padY = 44;
  const repulseStrength = 3400;

  for (let iter = 0; iter < 140; iter++) {
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
        const minGap = a.kind === "signal" || b.kind === "signal" ? 96 : 128;
        let force = repulseStrength / (dist * dist) + (dist < minGap ? (minGap - dist) * 0.18 : 0);
        // Extra vertical separation when two nodes share roughly the same x-column so labels don't overlap.
        if (Math.abs(dx) < 110 && Math.abs(dy) < 52) {
          const pushY = (52 - Math.abs(dy)) * 0.25 * (dy >= 0 ? 1 : -1);
          disp.get(a.id).y += pushY;
          disp.get(b.id).y -= pushY;
        }
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

function renderSignalClusterDetail(signalName, relatedAssets) {
  const pane = el("detail-pane");
  if (!signalName || !relatedAssets.length) {
    renderDetail(null);
    return;
  }
  const avgScore = relatedAssets.reduce((sum, a) => sum + Number(a.gdiScore || 0), 0) / relatedAssets.length;
  const closeBtn = `<button class="btn btn-close" data-close-signal type="button" title="Clear #${escapeHtml(signalName)} filter">✕</button>`;
  const rowsHtml = relatedAssets
    .map((item) => {
      const repoLabel = item.repoScope && item.repoScope !== "*" ? item.repoScope : "Cross-repo";
      const scopeText = item.scope === "team" ? "Team" : item.scope === "starter" ? "Built-in" : "Local";
      return `
      <button class="contrib-exp-item" data-jump-signal-exp="${escapeHtml(item.id)}" type="button">
        <span class="contrib-exp-title">${escapeHtml(item.title)}</span>
        <span class="contrib-exp-meta">${normalizeKind(item.type)} · ${escapeHtml(repoLabel)} · ${scopeText} · ${Number(item.gdiScore || 0).toFixed(1)}</span>
      </button>`;
    })
    .join("");

  pane.innerHTML = `
    <div class="detail-head">
      <div class="detail-title-row">
        ${renderScoreRing(avgScore)}
        <div>
          <h2 class="detail-title">#${escapeHtml(signalName)}</h2>
          <div class="detail-meta-line">
            <span class="detail-meta-pill">Signal Cluster</span>
            <span>·</span>
            <span>${relatedAssets.length} related experience(s)</span>
            <span>·</span>
            <span>Avg Score ${avgScore.toFixed(1)}</span>
          </div>
          <div class="detail-id-sub">Click any experience below to inspect full details</div>
        </div>
      </div>
      <div class="actions">${closeBtn}</div>
    </div>
    <div class="section-label">Related Experiences</div>
    <div class="contrib-exp-list">${rowsHtml}</div>
  `;

  pane.querySelector("[data-close-signal]")?.addEventListener("click", () => {
    selectedSignalHub = "";
    render();
  });
  pane.querySelectorAll("[data-jump-signal-exp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = getAllAssets().find((a) => a.id === btn.dataset.jumpSignalExp);
      if (!target) return;
      selectedSignalHub = "";
      activeTab = !target.scope || target.scope === "local" ? "local" : "assets";
      activeFilter = "all";
      activeKind = "all";
      selectedId = target.id;
      pendingDeleteId = "";
      render();
    });
  });
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
  const showSignals = true;

  const signalCounts = new Map();
  for (const a of allAssets) {
    for (const s of new Set((a.signals || []).map((x) => String(x).toLowerCase()))) {
      signalCounts.set(s, (signalCounts.get(s) || 0) + 1);
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
  for (const a of allAssets) {
    if ((a.signals || []).some((s) => hubSet.has(String(s).toLowerCase()))) {
      connectedIdSet.add(a.id);
    }
  }

  const signalClusterAssets = selectedSignalHub
    ? allAssets
        .filter((a) => (a.signals || []).some((s) => String(s).toLowerCase() === selectedSignalHub))
        .sort((a, b) => (b.gdiScore || 0) - (a.gdiScore || 0))
    : [];

  const visibleAssets = selectedSignalHub
    ? signalClusterAssets.slice().sort((a, b) => a.id.localeCompare(b.id))
    : allAssets
        .filter((a) => connectedIdSet.has(a.id))
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));

  const visibleHubs = selectedSignalHub
    ? sharedHubs.filter((h) => h.sig === selectedSignalHub)
    : sharedHubs;

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
    ...visibleAssets.map((a) => ({ id: a.id, kind: normalizeKind(a.type), asset: a })),
    ...visibleHubs.map((h) => ({ id: `sig:${h.sig}`, kind: "signal", sig: h.sig, count: h.count })),
  ];
  const graphLinks = [];
  const visibleSet = new Set(visibleAssets.map((a) => a.id));
  const visibleHubSet = new Set(visibleHubs.map((h) => h.sig));
  for (const e of edges) {
    if (e.kind !== "signal" && visibleSet.has(e.from) && visibleSet.has(e.to)) {
      graphLinks.push({ from: e.from, to: e.to, kind: e.kind, label: e.label });
    }
  }
  if (showSignals) {
    for (const a of visibleAssets) {
      for (const s of new Set((a.signals || []).map((x) => String(x).toLowerCase()))) {
        if (visibleHubSet.has(s)) {
          graphLinks.push({ from: a.id, to: `sig:${s}`, kind: "signal" });
        }
      }
    }
  }

  const width = Math.max(580, (listPane.clientWidth || 600) - 24);
  const height = selectedSignalHub
    ? Math.max(250, Math.min(320, 190 + graphNodes.length * 16))
    : Math.max(330, Math.min(500, 230 + graphNodes.length * 15));
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

  const hubsSvg = visibleHubs
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
      const k = normalizeKind(a.type);
      const isFix = k === "Fix";
      const isKnowledge = k === "Knowledge";
      const isSelected = a.id === selectedId;
      const dimmed = Boolean(focusKey) && !neighborIds.has(a.id);
      const r = Math.round(11 + Math.min(4, Math.max(0, ((a.gdiScore || 50) - 50) / 12)));
      const label = (a.title || a.id).length > 22 ? `${(a.title || a.id).slice(0, 21)}…` : a.title || a.id;
      const fill = isFix ? "var(--accent-soft)" : isKnowledge ? "var(--accent-deep)" : "var(--accent)";
      return `
      <g class="kg-node" data-node-id="${escapeHtml(a.id)}" opacity="${dimmed ? 0.2 : 1}">
        ${isSelected ? `<circle cx="${p.x}" cy="${p.y}" r="${r + 5}" fill="var(--accent-muted)" stroke="var(--accent)" stroke-width="1.5" />` : ""}
        ${
          isFix
            ? `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="var(--bg)" stroke="${fill}" stroke-width="2.5" /><circle cx="${p.x}" cy="${p.y}" r="${Math.max(4, r - 5)}" fill="${fill}" />`
            : isKnowledge
              ? `<rect x="${p.x - r}" y="${p.y - r}" width="${r * 2}" height="${r * 2}" rx="5" fill="${fill}" stroke="#ffffff" stroke-width="1.5" />`
              : `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="#ffffff" stroke-width="1.5" />`
        }
        <text x="${p.x}" y="${p.y + 3.5}" text-anchor="middle" fill="#ffffff" font-size="9" font-weight="700" font-family="Consolas, monospace">${isFix ? "" : isKnowledge ? "K" : "R"}</text>
        <text x="${p.x}" y="${p.y + r + 14}" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="${isSelected ? "700" : "600"}">${escapeHtml(label)}</text>
        <title>${escapeHtml(a.title)} (${k} · Score ${a.gdiScore ?? "-"})</title>
      </g>`;
    })
    .join("");

  const signalBarHtml =
    showSignals && sharedHubs.length
      ? `<div class="kg-signal-bar">
          ${selectedSignalHub ? `<button class="kg-signal-chip" data-hub-clear type="button">All clusters</button>` : ""}
          ${sharedHubs
            .map(
              (h) =>
                `<button class="kg-signal-chip ${selectedSignalHub === h.sig ? "active" : ""}" data-hub-sig="${escapeHtml(h.sig)}" type="button">#${escapeHtml(h.sig)} <span class="kg-signal-count">${h.count}</span></button>`
            )
            .join("")}
        </div>`
      : "";

  listPane.innerHTML = `
    ${signalBarHtml}
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
      <div class="kg-hint">Click node or #signal to inspect related experiences</div>
      <div class="kg-legend">
        <span><i class="dot dot-knowledge"></i>Knowledge</span>
        <span><i class="dot dot-rule"></i>Rule</span>
        <span><i class="kg-ring-dot"></i>Fix</span>
        <span><i class="dot dot-signal"></i>#Signal (${sharedHubs.length})</span>
      </div>
    </div>
  `;

  listPane.querySelectorAll("[data-node-id]").forEach((node) => {
    node.addEventListener("click", () => {
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
  listPane.querySelector("[data-hub-clear]")?.addEventListener("click", () => {
    selectedSignalHub = "";
    render();
  });

  if (selectedId && selectedAsset) {
    renderDetail(selectedAsset);
  } else if (selectedSignalHub) {
    renderSignalClusterDetail(selectedSignalHub, signalClusterAssets);
  } else {
    renderDetail(null);
  }
}

function buildContributorStats(assets, mode = "author") {
  const scoped = assets.filter((item) => item.scope === "team");

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
        <span class="contrib-exp-meta">${normalizeKind(item.type)} · ${Number(item.gdiScore || 0).toFixed(1)} · ${item.successCount || 0} used</span>
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
      <div class="mini-dim">Quality <strong>${group.avgQuality}</strong><progress class="score-bar" max="100" value="${Number(group.avgQuality || 0)}"></progress></div>
      <div class="mini-dim">Reliability <strong>${group.avgReliability}</strong><progress class="score-bar" max="100" value="${Number(group.avgReliability || 0)}"></progress></div>
      <div class="mini-dim">Lineage <strong>${group.avgLineage}</strong><progress class="score-bar" max="100" value="${Number(group.avgLineage || 0)}"></progress></div>
      <div class="mini-dim">Freshness <strong>${group.avgFreshness}</strong><progress class="score-bar" max="100" value="${Number(group.avgFreshness || 0)}"></progress></div>
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
  const knowledge = state.knowledge || [];
  const allAssets = [...knowledge, ...rules, ...fixes];
  const totalReuses = allAssets.reduce((sum, a) => sum + (a.successCount || 0), 0);
  const linkCount = collectGraphData(allAssets).length;

  const syncTime = state.config?.lastAutoPullAt
    ? ` · synced ${formatLocalTime(state.config.lastAutoPullAt).slice(11, 16)}`
    : "";
  const tel = el("telemetry-line");
  const syncRepoSlug = state.config?.syncRepo || "";
  if (tel) {
    tel.textContent = `${knowledge.length} knowledge · ${rules.length} rules · ${fixes.length} fixes · ${state.counts?.teamAssets || 0} shared · ${totalReuses} hits${syncTime}`;
    tel.title = state.syncRepoPath
      ? `Team data repo: ${syncRepoSlug || state.syncRepoPath} (${state.syncRepoPath})`
      : syncRepoSlug
        ? `Team data repo: ${syncRepoSlug}`
        : "Local-only mode — click Connect Team Repo to share with a team";
  }

  const repoBtn = el("btn-team-repo");
  const repoLabelEl = el("team-repo-label");
  const pullBtn = el("btn-pull");
  const hasSyncConfigured = Boolean(syncRepoSlug || state.syncRepoPath);
  if (repoBtn && repoLabelEl) {
    repoBtn.classList.toggle("btn-repo-unset", !hasSyncConfigured);
    const shortRepo = syncRepoSlug
      ? syncRepoSlug.split("/").pop()
      : state.syncRepoPath
        ? state.syncRepoPath.split(/[\\/]/).pop()
        : "Connect Team Repo";
    repoLabelEl.textContent = shortRepo;
    repoBtn.title = hasSyncConfigured
      ? `Team repo: ${syncRepoSlug || state.syncRepoPath} (click to configure)`
      : "Connect or create a private Git repository for team sharing";
  }
  pullBtn?.classList.toggle("hidden", !hasSyncConfigured);

  const contributorGroups = buildContributorStats(getAllAssets(), contribMode);
  const localCount = allAssets.filter((a) => !a.scope || a.scope === "local").length;
  const teamCount = allAssets.filter((a) => a.scope === "team").length;
  const starterCount = allAssets.filter((a) => a.scope === "starter").length;
  const sharedCount = teamCount + starterCount;
  const curRepo = (state.currentRepo || "").toLowerCase();
  const tabAssets = allAssets.filter((a) =>
    activeTab === "local" ? !a.scope || a.scope === "local" : a.scope && a.scope !== "local"
  );
  const tabKnowledgeCount = tabAssets.filter((a) => normalizeKind(a.type) === "Knowledge").length;
  const tabRuleCount = tabAssets.filter((a) => normalizeKind(a.type) === "Rule").length;
  const tabFixCount = tabAssets.filter((a) => normalizeKind(a.type) === "Fix").length;
  const kindScopedAssets =
    activeKind === "all"
      ? tabAssets
      : tabAssets.filter((a) => normalizeKind(a.type) === activeKind);
  const kindTeamCount = kindScopedAssets.filter((a) => a.scope === "team").length;
  const kindStarterCount = kindScopedAssets.filter((a) => a.scope === "starter").length;
  const crossRepoCount = kindScopedAssets.filter((a) => (a.repoScope || "*") === "*").length;
  const repoOnlyCount = kindScopedAssets.filter((a) => isRepoSpecificMatch(a, curRepo)).length;

  el("count-assets").textContent = String(sharedCount);
  if (el("count-local")) el("count-local").textContent = String(localCount);
  el("count-contributors").textContent = String(contributorGroups.length);
  el("count-links").textContent = String(linkCount);
  el("count-events").textContent = String(state.counts?.events || 0);

  document.querySelectorAll(".seg[data-kind]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.kind === activeKind);
    if (btn.dataset.kind === "all") btn.textContent = `All`;
    else if (btn.dataset.kind === "Knowledge") btn.textContent = `Knowledge ${tabKnowledgeCount}`;
    else if (btn.dataset.kind === "Rule") btn.textContent = `Rules ${tabRuleCount}`;
    else if (btn.dataset.kind === "Fix") btn.textContent = `Fixes ${tabFixCount}`;
  });

  if (el("chip-all")) {
    el("chip-all").textContent = `All ${kindScopedAssets.length}`;
  }
  if (el("chip-team")) {
    el("chip-team").textContent = `Team ${kindTeamCount}`;
  }
  if (el("chip-starter")) {
    el("chip-starter").textContent = `Built-in ${kindStarterCount}`;
  }
  const crossRepoBtn = el("chip-cross-repo");
  if (crossRepoBtn) {
    crossRepoBtn.classList.toggle("active", repoScopeFilter === "cross");
    crossRepoBtn.textContent = `Cross-repo (${crossRepoCount})`;
  }
  const repoOnlyBtn = el("chip-repo-only");
  if (repoOnlyBtn) {
    repoOnlyBtn.classList.toggle("active", repoScopeFilter === "repo");
    repoOnlyBtn.textContent = state.currentRepo
      ? `${state.currentRepo} (${repoOnlyCount})`
      : `Repo-scoped (${repoOnlyCount})`;
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
  el("events-toolbar").classList.toggle("hidden", activeTab !== "events");
  const hasDetail =
    ((activeTab === "assets" || activeTab === "local") && Boolean(selectedId)) ||
    (activeTab === "relationships" && Boolean(selectedId || selectedSignalHub)) ||
    (activeTab === "contributors" && Boolean(selectedContribKey));
  el("content").classList.toggle("single-pane", !hasDetail);
  el("content").classList.toggle("graph-pane", activeTab === "relationships" && hasDetail);
  el("pane-splitter")?.classList.toggle("hidden", !hasDetail);
  el("detail-pane").classList.toggle("hidden", !hasDetail);

  document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === activeTab));
  document.querySelectorAll(".chip[data-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.filter === activeFilter));
  document.querySelectorAll(".seg[data-kind]").forEach((btn) => btn.classList.toggle("active", btn.dataset.kind === activeKind));
  document.querySelectorAll(".seg[data-contrib-mode]").forEach((btn) => btn.classList.toggle("active", btn.dataset.contribMode === contribMode));
  document.querySelectorAll(".chip[data-event-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.eventFilter === eventFilter));
  el("scope-filters")?.classList.toggle("hidden", activeTab !== "assets");

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
    const visibleEvents = events.slice(0, eventDisplayLimit);
    const remainingEvents = Math.max(0, events.length - visibleEvents.length);
    const assetById = new Map(allAssets.map((a) => [a.id, a]));
    listPane.innerHTML = visibleEvents.length
      ? `<div class="timeline">${visibleEvents
          .map((ev) => {
            const meta = formatEventMeta(ev);
            const isWarn = meta.cls === "ev-warn";
            const sigs = (ev.signals || []).map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join("");
            const shortSid = ev.sessionId ? ev.sessionId.slice(0, 8) : "";
            const sessionLabel = ev.sessionName
              ? `${ev.sessionName}${shortSid ? ` · ${shortSid}` : ""}`
              : shortSid || "";
            const sessionBadge = ev.sessionId
              ? `<button class="event-session-pill" data-ev-session="${escapeHtml(ev.sessionId)}" type="button" title="Filter events from session ${escapeHtml(ev.sessionId)}">${escapeHtml(sessionLabel)}</button>`
              : "";
            const placeLabel = ev.repo || ev.project || "";
            const placeBadge = placeLabel ? `<span class="event-repo-pill" title="Workspace / repository">${escapeHtml(placeLabel)}</span>` : "";
            const linkedIds = (ev.assetIds && ev.assetIds.length ? ev.assetIds : ev.assetId ? [ev.assetId] : []).filter(Boolean);
            const assetChips =
              linkedIds.length && ev.event !== "delete"
                ? `<div class="event-asset-chips">${linkedIds
                    .map((id, idx) => {
                      const title = ev.assetTitles?.[idx] || assetById.get(id)?.title || id;
                      return `<button class="event-asset-chip" data-ev-jump="${escapeHtml(id)}" type="button" title="Open ${escapeHtml(id)}">${escapeHtml(title)}</button>`;
                    })
                    .join("")}</div>`
                : "";
            return `
            <div class="event-row ${isWarn ? "is-warn" : ""}">
              <div class="event-top">
                <div class="event-top-left">
                  <span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span>
                  ${sessionBadge}
                  ${placeBadge}
                </div>
                <span class="muted" title="${escapeHtml(ev.ts || "")}">${escapeHtml(formatLocalTime(ev.ts))}</span>
              </div>
              <div class="event-detail">${escapeHtml(meta.desc)}</div>
              ${assetChips}
              ${sigs ? `<div class="badges">${sigs}</div>` : ""}
            </div>`;
          })
          .join("")}</div>${
          remainingEvents > 0
            ? `<div class="events-more-wrap"><button id="btn-events-more" class="btn btn-quiet" type="button">Show 25 more (${remainingEvents} older)</button></div>`
            : ""
        }`
      : `<div class="empty">No matching evolution events recorded.</div>`;
    el("btn-events-more")?.addEventListener("click", () => {
      eventDisplayLimit += 25;
      render();
    });
    listPane.querySelectorAll("[data-ev-session]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sid = btn.dataset.evSession;
        eventSessionFilter = eventSessionFilter === sid ? "" : sid;
        eventDisplayLimit = 25;
        render();
      });
    });
    listPane.querySelectorAll("[data-ev-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = allAssets.find((a) => a.id === btn.dataset.evJump);
        if (!target) return;
        activeTab = !target.scope || target.scope === "local" ? "local" : "assets";
        activeFilter = "all";
        activeKind = "all";
        selectedId = target.id;
        pendingDeleteId = "";
        render();
      });
    });
    return;
  }

  const items = itemsForTab;
  if (!items.length) {
    const emptyMsg =
      activeTab === "local"
        ? "No local experiences right now. Copilot automatically captures reusable rules and verified fixes here."
        : "No experiences match the current filters.";
    listPane.innerHTML = `<div class="empty">${emptyMsg}</div>`;
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
        const itemKind = normalizeKind(item.type);
        const kindCls =
          itemKind === "Fix" ? "is-fix" : itemKind === "Knowledge" ? "is-knowledge" : "is-rule";
        const repoLabel =
          item.repoScope && item.repoScope !== "*" ? escapeHtml(item.repoScope) : "Cross-repo";
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
        const kindTooltip =
          itemKind === "Fix"
            ? "Fix: verified bug resolution"
            : itemKind === "Knowledge"
              ? "Knowledge: domain, architecture, or platform behavior"
              : "Rule: reusable guideline or workflow";
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
          ? `<div class="col-action">${
              !item.scope || item.scope === "local"
                ? `<button class="row-share-icon" data-quick-share="${escapeHtml(item.id)}" type="button" ${isSharing ? "disabled" : ""} title="Share with your team" aria-label="Share with your team">${shareIconSvg}</button>`
                : ""
            }</div>`
          : "";
        const allSignals = Array.isArray(item.signals) ? item.signals : [];
        const visibleSignals = allSignals.slice(0, 3);
        const extraSignalCount = Math.max(0, allSignals.length - visibleSignals.length);
        const labelsHtml = visibleSignals.length
          ? `<span class="exp-labels">${visibleSignals
              .map(
                (s) =>
                  `<button class="exp-label" data-filter-signal="${escapeHtml(s)}" type="button" title="Filter by #${escapeHtml(s)}">#${escapeHtml(s)}</button>`
              )
              .join("")}${extraSignalCount ? `<span class="exp-label-more">+${extraSignalCount}</span>` : ""}</span>`
          : "";
        const relTime = formatRelativeTime(item.updatedAt);
        const timeBadge = relTime
          ? `<span class="exp-origin" title="Updated ${escapeHtml(formatLocalTime(item.updatedAt))}">${escapeHtml(relTime)}</span>`
          : "";
        const footMeta = [footText ? `<span class="exp-origin">${footText}</span>` : "", timeBadge]
          .filter(Boolean)
          .join("<span>·</span>");
        const footHtml =
          footMeta || labelsHtml
            ? `<div class="exp-foot">${footMeta}${footMeta && labelsHtml ? `<span>·</span>` : ""}${labelsHtml}</div>`
            : "";
        return `
        <div class="exp-row ${showShareCol ? "has-share" : ""} ${item.id === selectedId ? "selected" : ""} ${item.id === justSharedId ? "just-shared" : ""}" data-id="${escapeHtml(item.id)}">
          ${rankCell}
          <div class="exp-main">
            <div class="exp-title-line">
              <span class="exp-title">${escapeHtml(item.title)}</span>
              <span class="row-kind ${kindCls}" title="${kindTooltip}">${itemKind}</span>
              <span class="row-scope" title="Repository scope">${repoLabel}</span>
            </div>
            <div class="exp-summary">${escapeHtml(item.summary)}</div>
            ${footHtml}
          </div>
          <span class="exp-score col-num" title="${escapeHtml(buildScoreTooltips(item).totalTip)}">${scoreVal}</span>
          <span class="exp-reuses col-num" title="Helpful uses: ${uses}${item.recallCount ? ` · Recalled: ${item.recallCount}` : ""}">${uses}</span>
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

  listPane.querySelectorAll("[data-filter-signal]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const sig = btn.dataset.filterSignal || "";
      searchQuery = searchQuery === sig ? "" : sig;
      if (el("search-input")) el("search-input").value = searchQuery;
      render();
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
    const serverTab =
      state.viewState.tab === "arena" || state.viewState.tab === "contributors"
        ? "assets"
        : state.viewState.tab;
    activeTab = state.viewState.filter === "local" ? "local" : serverTab || activeTab;
    activeFilter = state.viewState.filter === "local" ? "all" : state.viewState.filter || activeFilter;
    if (state.viewState.assetId) selectedId = state.viewState.assetId;
  }
  render();
}

function setRepoModalBusy(busy, message = "") {
  const loadingEl = el("repo-modal-loading");
  const textEl = el("repo-modal-loading-text");
  const input = el("repo-modal-input");
  const controls = [
    el("btn-repo-connect"),
    el("btn-repo-create"),
    el("btn-repo-disconnect"),
    el("btn-repo-close"),
  ].filter(Boolean);
  controls.forEach((b) => {
    b.disabled = Boolean(busy);
  });
  if (input) input.disabled = Boolean(busy);
  if (loadingEl) {
    loadingEl.classList.toggle("hidden", !busy);
    if (textEl && message) textEl.textContent = message;
  }
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
  } else if (endpoint === "/api/sync/configure") {
    setRepoModalBusy(
      true,
      body?.createPrivate
        ? "Creating private team repo..."
        : body?.repo
          ? "Connecting team repo..."
          : "Disconnecting..."
    );
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
      const msg = data.error || "Operation failed.";
      if (endpoint === "/api/sync/configure" && el("repo-modal-error")) {
        const errEl = el("repo-modal-error");
        errEl.textContent = msg;
        errEl.classList.remove("hidden");
      } else {
        showBanner(msg, true);
      }
    } else if (endpoint === "/api/sync/configure") {
      el("repo-modal-error")?.classList.add("hidden");
      el("repo-modal")?.classList.add("hidden");
      if (data.disconnected) {
        showToast("Disconnected team repo", "Switched back to local-only mode.");
      } else {
        showToast(
          "Team repo connected!",
          `${data.syncRepo} · ${data.imported || 0} pulled${data.pushed ? " · existing team items pushed" : ""}`
        );
      }
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
          state?.config?.syncRepo || state?.syncRepoPath
            ? `Thanks for contributing "${data.asset?.title || data.asset?.id}".`
            : "Connect a private Team Repo above to sync this with teammates."
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
    setRepoModalBusy(false);
    setLoadingOverlay(false);
    await loadState(false);
  } catch (err) {
    sharingId = "";
    setRepoModalBusy(false);
    setLoadingOverlay(false);
    if (endpoint === "/api/sync/configure" && el("repo-modal-error")) {
      const errEl = el("repo-modal-error");
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
    } else {
      showBanner(err.message, true);
    }
    render();
  } finally {
    sharingId = "";
    setRepoModalBusy(false);
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

  document.querySelectorAll(".chip[data-event-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      eventFilter = btn.dataset.eventFilter;
      eventDisplayLimit = 25;
      render();
    });
  });

  el("chip-event-session")?.addEventListener("click", () => {
    eventSessionFilter = eventSessionFilter === "current" ? "" : "current";
    eventDisplayLimit = 25;
    render();
  });

  el("event-search-input")?.addEventListener("input", (e) => {
    eventSearchQuery = e.target.value;
    eventDisplayLimit = 25;
    render();
  });

  el("chip-cross-repo")?.addEventListener("click", () => {
    repoScopeFilter = repoScopeFilter === "cross" ? "" : "cross";
    render();
  });

  el("chip-repo-only")?.addEventListener("click", () => {
    repoScopeFilter = repoScopeFilter === "repo" ? "" : "repo";
    render();
  });

  el("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });

  el("btn-pull")?.addEventListener("click", () => mutate("/api/sync/pull", {}));

  const toRepoWebUrl = (syncRepo) => {
    const val = String(syncRepo || "").trim();
    if (!val) return "";
    if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i.test(val)) {
      return val.replace(/\.git$/i, "");
    }
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(val)) {
      return `https://github.com/${val}`;
    }
    return "";
  };

  const openRepoModal = () => {
    const modal = el("repo-modal");
    const input = el("repo-modal-input");
    const disBtn = el("btn-repo-disconnect");
    const errEl = el("repo-modal-error");
    const metaEl = el("repo-modal-meta");
    const linkEl = el("repo-modal-link");
    if (!modal) return;
    const currentRepo = state?.config?.syncRepo || "";
    if (input) input.value = currentRepo;
    const webUrl = toRepoWebUrl(currentRepo);
    if (metaEl && linkEl) {
      if (webUrl) {
        linkEl.href = webUrl;
        linkEl.textContent = `${currentRepo} ↗`;
        metaEl.classList.remove("hidden");
      } else {
        metaEl.classList.add("hidden");
      }
    }
    setRepoModalBusy(false);
    errEl?.classList.add("hidden");
    disBtn?.classList.toggle("hidden", !(currentRepo || state?.syncRepoPath));
    modal.classList.remove("hidden");
    input?.focus();
  };
  const showRepoError = (msg) => {
    const errEl = el("repo-modal-error");
    if (!errEl) return showBanner(msg, true);
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  };
  el("btn-team-repo")?.addEventListener("click", openRepoModal);
  el("btn-repo-close")?.addEventListener("click", () => {
    if (el("btn-repo-close")?.disabled) return;
    el("repo-modal")?.classList.add("hidden");
  });
  el("repo-modal")?.addEventListener("click", (e) => {
    if (e.target === el("repo-modal") && !el("btn-repo-close")?.disabled) {
      el("repo-modal")?.classList.add("hidden");
    }
  });
  el("btn-repo-connect")?.addEventListener("click", () => {
    const val = el("repo-modal-input")?.value?.trim();
    if (!val) {
      showRepoError("Enter a repository like owner/copilot-evo-data.");
      return;
    }
    el("repo-modal-error")?.classList.add("hidden");
    mutate("/api/sync/configure", { repo: val, createPrivate: false });
  });
  el("btn-repo-create")?.addEventListener("click", () => {
    const val = el("repo-modal-input")?.value?.trim();
    if (!val) {
      showRepoError("Enter a new private repository name like owner/copilot-evo-data.");
      return;
    }
    el("repo-modal-error")?.classList.add("hidden");
    mutate("/api/sync/configure", { repo: val, createPrivate: true });
  });
  el("btn-repo-disconnect")?.addEventListener("click", () => {
    mutate("/api/sync/configure", { repo: "" });
  });

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
    if (e.key === "Escape" && (selectedId || selectedContribKey || selectedSignalHub)) {
      selectedId = "";
      selectedContribKey = "";
      selectedSignalHub = "";
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
