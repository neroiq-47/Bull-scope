// Bull-Scope front end. Paper-first: no code path here places, cancels or withdraws anything.
// All Kraken access goes through the server component at API_BASE. No credentials live in the browser.

import { API_BASE } from "./js/config.js";
import { CONFIG, computePlan } from "./js/strategy.js";

const POLL_MS = 15000;
const PAPER_KEY = "bullscope.paperTrades";
const MAX_REJECTED_IDS = 200;
const WITHDRAW_FEE_STATUS = "unverified"; // Only switch to "verified" after checking Kraken's live quote.

const gbpPrecise = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const btcFmt = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 8 });

const $ = (sel) => document.querySelector(sel);
const ROUTES = ["dashboard", "trades", "funds", "connect"];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function flash(message) {
  const el = $("#flash");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

function notConfiguredMessage() {
  return "Server not configured yet. Deploy the Worker and set API_BASE in js/config.js (see README).";
}

/* ---------- Routing ---------- */

function showRoute() {
  const hash = location.hash.replace("#", "");
  const route = ROUTES.includes(hash) ? hash : "dashboard";
  document.querySelectorAll("[data-view]").forEach((section) => {
    section.hidden = section.dataset.view !== route;
  });
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.route === route) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const heading = document.querySelector(`[data-view="${route}"] h1`);
  if (heading) heading.focus({ preventScroll: true });
}

/* ---------- API ---------- */

async function api(path) {
  if (!API_BASE) {
    const err = new Error(notConfiguredMessage());
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" }, credentials: "omit" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ---------- Live price ---------- */

let lastPrice = null;

async function refreshPrice() {
  try {
    const data = await api("/v1/market/btc-gbp");
    const price = Number(data.last);
    if (!Number.isFinite(price)) throw new Error("Invalid price");
    const dir = lastPrice === null ? "" : price > lastPrice ? " ▲" : price < lastPrice ? " ▼" : "";
    $("#price").textContent = `${gbpPrecise.format(price)}${dir}`;
    $("#price-meta").textContent = `Source: Kraken public ticker · updated ${new Date(data.asOf).toLocaleTimeString("en-GB")}`;
    lastPrice = price;
    renderOpenTrades();
  } catch (err) {
    $("#price").textContent = "Price unavailable";
    $("#price-meta").textContent = err.status === 503 ? notConfiguredMessage() : `Could not reach the price service (${err.message}).`;
  }
}

/* ---------- Signal status ---------- */

async function refreshSignal() {
  const el = $("#signal");
  try {
    const s = await api("/v1/signal/btc-gbp");
    const trendPill = s.trend15m === "up"
      ? '<span class="pill ok">Up</span>'
      : s.trend15m === "down" ? '<span class="pill danger">Down</span>' : '<span class="pill neutral">Flat</span>';
    const pullbackPill = s.pullback5m
      ? '<span class="pill ok">Pullback found</span>'
      : '<span class="pill neutral">No pullback</span>';
    el.innerHTML = `
      <div class="status-line">${trendPill} ${pullbackPill}</div>
      <dl class="kv">
        <dt>15-minute trend</dt><dd>${escapeHtml(s.trend15mText || "—")}</dd>
        <dt>5-minute pullback</dt><dd>${escapeHtml(s.pullback5mText || "—")}</dd>
        <dt>Last checked</dt><dd>${escapeHtml(new Date(s.asOf).toLocaleTimeString("en-GB"))}</dd>
      </dl>
      <p class="small muted">Signals are checked on closed candles only.</p>`;
    const rejected = $("#rejected");
    rejected.textContent = s.rejectedReason ? `No plan: ${s.rejectedReason}` : "";
    rejected.hidden = !s.rejectedReason;
    currentProposals = s.proposals || [];
    renderProposals();
  } catch (err) {
    el.innerHTML = `<p class="muted">${escapeHtml(err.status === 503 ? notConfiguredMessage() : `Signal unavailable: ${err.message}.`)}</p>`;
  }
}

/* ---------- Paper state (localStorage, per browser) ---------- */

function loadPaper() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PAPER_KEY));
    return { open: parsed?.open || [], rejected: parsed?.rejected || [] };
  } catch {
    return { open: [], rejected: [] };
  }
}

function savePaper(state) {
  try {
    localStorage.setItem(PAPER_KEY, JSON.stringify({
      open: state.open,
      rejected: state.rejected.slice(-MAX_REJECTED_IDS),
    }));
  } catch { /* storage unavailable: nothing is persisted, the UI still works */ }
}

/* ---------- Trade proposals ---------- */

let currentProposals = [];

function renderProposals() {
  const el = $("#proposals");
  if (!el) return;
  const now = Date.now();
  const paper = loadPaper();
  const visible = currentProposals.filter((p) =>
    new Date(p.expiresAt) > now && !paper.rejected.includes(p.id) && !paper.open.some((t) => t.id === p.id));

  el.innerHTML = visible.map((p) => {
    const plan = computePlan({ entry: p.entry, stop: p.stop, target: p.target });
    if (!plan) return "";
    const minutesLeft = Math.max(0, Math.ceil((new Date(p.expiresAt) - now) / 60000));
    const rate = (CONFIG.takerFeeRate * 100).toFixed(2);
    return `
      <article class="card proposal" aria-labelledby="prop-${escapeHtml(p.id)}">
        <header>
          <h3 id="prop-${escapeHtml(p.id)}">Long BTC/GBP · paper</h3>
          <span class="pill warn">Expires in ${minutesLeft} min</span>
        </header>
        <dl class="kv plan">
          <dt>Entry</dt><dd>${gbpPrecise.format(p.entry)}</dd>
          <dt>Stop</dt><dd>${gbpPrecise.format(p.stop)}</dd>
          <dt>Target (2R)</dt><dd>${gbpPrecise.format(p.target)}</dd>
          <dt>Position size</dt><dd>${gbpPrecise.format(plan.sizeGbp)}</dd>
          <dt>Risk if stopped (incl. fees)</dt><dd>${gbpPrecise.format(plan.riskGbp)}</dd>
          <dt>Estimated fees (round trip)</dt><dd>${gbpPrecise.format(plan.feesGbp)}</dd>
          <dt>Net reward-to-risk</dt><dd>${plan.netRewardRatio.toFixed(2)}R</dd>
        </dl>
        <p class="small muted">Fees estimated at a ${rate}% placeholder per side. Paper only: approving records a simulated position and sends no order to Kraken.</p>
        <div class="actions">
          <button class="btn primary" type="button" data-action="approve" data-id="${escapeHtml(p.id)}">Approve paper trade</button>
          <button class="btn ghost" type="button" data-action="reject" data-id="${escapeHtml(p.id)}">Reject</button>
        </div>
      </article>`;
  }).join("");

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => decide(btn.dataset.action, btn.dataset.id));
  });
}

function decide(action, id) {
  const proposal = currentProposals.find((p) => p.id === id);
  if (!proposal) return flash("That proposal is no longer available.");
  if (new Date(proposal.expiresAt) <= Date.now()) {
    flash("This proposal has expired.");
    return renderProposals();
  }
  const state = loadPaper();
  if (action === "approve") {
    if (!state.open.some((t) => t.id === id)) {
      state.open.push({
        id,
        entry: proposal.entry,
        stop: proposal.stop,
        target: proposal.target,
        approvedAt: new Date().toISOString(),
        paper: true,
      });
    }
    flash("Paper trade recorded. No order was sent to Kraken.");
  } else {
    if (!state.rejected.includes(id)) state.rejected.push(id);
    flash("Proposal rejected.");
  }
  savePaper(state);
  renderProposals();
  renderOpenTrades();
}

/* ---------- Open paper trades (estimate only) ---------- */

function markPaperTrade(t, price) {
  const plan = computePlan({ entry: t.entry, stop: t.stop, target: t.target });
  if (!plan || !Number.isFinite(price)) return null;
  const grossGbp = plan.qty * (price - t.entry);
  const feesGbp = plan.sizeGbp * CONFIG.takerFeeRate + plan.qty * price * CONFIG.takerFeeRate;
  const status = price <= t.stop ? "At or below paper stop" : price >= t.target ? "At or above paper target" : "Open";
  return { netGbp: grossGbp - feesGbp, status };
}

function renderOpenTrades() {
  const el = $("#open-trades");
  if (!el) return;
  const state = loadPaper();
  el.innerHTML = state.open.map((t) => {
    const mark = lastPrice !== null ? markPaperTrade(t, lastPrice) : null;
    const pnl = mark
      ? `${gbpPrecise.format(mark.netGbp)} (after estimated fees) · ${escapeHtml(mark.status)}`
      : "Waiting for price";
    return `
    <article class="card">
      <header><h3>Paper long · ${escapeHtml(new Date(t.approvedAt).toLocaleString("en-GB"))}</h3><span class="pill neutral">Paper</span></header>
      <dl class="kv">
        <dt>Entry</dt><dd>${gbpPrecise.format(t.entry)}</dd>
        <dt>Stop</dt><dd>${gbpPrecise.format(t.stop)}</dd>
        <dt>Target</dt><dd>${gbpPrecise.format(t.target)}</dd>
        <dt>Unrealised estimate</dt><dd>${pnl}</dd>
      </dl>
      <p class="small muted">Paper position only. Close it in your own records; nothing is sent to Kraken.</p>
    </article>`;
  }).join("") || "";
}

/* ---------- Portfolio (read-only, via server) ---------- */

async function refreshPortfolio() {
  const el = $("#portfolio");
  try {
    const data = await api("/v1/account/balances");
    const rows = (data.balances || []).map((b) => `
      <dt>${escapeHtml(b.asset)}</dt>
      <dd>${btcFmt.format(b.amount)}${b.gbpValue != null ? ` · ${gbpPrecise.format(b.gbpValue)}` : " · GBP value unavailable"}</dd>`).join("");
    el.innerHTML = `
      <dl class="kv">${rows || "<dt>Balances</dt><dd>None reported</dd>"}</dl>
      <p class="small muted">Read-only view from Kraken. Refreshed ${escapeHtml(new Date().toLocaleTimeString("en-GB"))}.</p>`;
  } catch (err) {
    if (err.status === 503) el.innerHTML = `<p class="muted">${escapeHtml(notConfiguredMessage())}</p>`;
    else if (err.status === 401) el.innerHTML = '<p class="muted">Not connected. Check the read-only key on the Connect tab.</p>';
    else el.innerHTML = `<p class="muted">Balances unavailable: ${escapeHtml(err.message)}.</p>`;
  }
}

/* ---------- Withdrawal fee preview ---------- */

function setupWithdrawPreview() {
  const form = $("#withdraw-form");
  const input = $("#wd-amount");
  const result = $("#wd-result");
  form.addEventListener("submit", (e) => e.preventDefault());
  input.addEventListener("input", () => {
    const amount = Number(input.value);
    if (!input.value || !Number.isFinite(amount) || amount <= 0) {
      result.textContent = "Enter an amount to preview fees.";
      return;
    }
    // Withdrawal fees are not verified here. Show them as unverified until a live Kraken quote confirms them.
    result.innerHTML = `
      <p><strong>Requested:</strong> ${gbpPrecise.format(amount)}</p>
      <p><strong>Kraken fee:</strong> not yet confirmed. Check the live GBP withdrawal quote in your Kraken account before withdrawing.</p>
      <p class="small muted">Status: ${escapeHtml(WITHDRAW_FEE_STATUS)}. No withdrawal can be made from this site.</p>`;
  });
}

/* ---------- Connection test ---------- */

function setupConnectionTest() {
  const btn = $("#test-connection");
  const out = $("#connection-status");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    out.innerHTML = '<p class="muted">Testing…</p>';
    try {
      const data = await api("/v1/account/status");
      out.innerHTML = `
        <div class="status-line"><span class="pill ok">Connected (read-only)</span></div>
        <p class="small muted">Permissions: ${escapeHtml((data.permissions || ["unknown"]).join(", "))}. Remove anything beyond Query Funds in Kraken.</p>`;
      refreshPortfolio();
    } catch (err) {
      const msg = err.status === 503 ? notConfiguredMessage()
        : err.status === 401 ? "Kraken rejected the key. Check it was created with Query Funds only."
        : `Test failed: ${err.message}`;
      out.innerHTML = `<div class="status-line"><span class="pill danger">Not connected</span></div><p class="muted">${escapeHtml(msg)}</p>`;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------- Boot ---------- */

function refreshAll() {
  refreshPrice();
  refreshSignal();
  refreshPortfolio();
}

function boot() {
  window.addEventListener("hashchange", showRoute);
  showRoute();
  setupWithdrawPreview();
  setupConnectionTest();
  renderOpenTrades();
  refreshAll();
  setInterval(() => {
    if (document.visibilityState === "visible") refreshAll();
  }, POLL_MS);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
