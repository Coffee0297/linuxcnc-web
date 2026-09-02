/* MPG pendant — GPL-2.0 (same as linuxcnc-web) */
"use strict";

/* ------------------------------------------------------------ settings -- */
const DETENT_DEG = 15;          // wheel degrees per detent (24 per rev)
const WHEEL_FLUSH_MS = 60;      // batch detents to the server at this rate
const KEEPALIVE_MS = 150;       // continuous-jog deadman refresh
const WHEEL_FEED = 3000;        // mm/min used for wheel increments

const settings = Object.assign(
  { axis: "x", mode: "mpg", step: 0.1, speed: 600, coord: "work", vibrate: true, toolDia: 6.0 },
  loadSettings()
);
sanitizeSettings();

function sanitizeSettings() {
  // localStorage can hold anything (older versions, hand edits); a bad value
  // must not break render() and take the whole pendant down with it
  const num = (v, d) => (typeof v === "number" && isFinite(v) && v > 0 ? v : d);
  if (!["mpg", "jog"].includes(settings.mode)) settings.mode = "mpg";
  if (!["work", "mach"].includes(settings.coord)) settings.coord = "work";
  if (typeof settings.axis !== "string") settings.axis = "x";
  settings.step = num(settings.step, 0.1);
  settings.speed = num(settings.speed, 600);
  settings.toolDia = num(settings.toolDia, 6.0);
  settings.vibrate = settings.vibrate !== false;
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem("mpg-settings")) || {}; }
  catch (e) { return {}; }
}
function saveSettings() {
  try { localStorage.setItem("mpg-settings", JSON.stringify(settings)); }
  catch (e) { /* private mode etc. */ }
}

/* ------------------------------------------------------------- helpers -- */
const $ = (id) => document.getElementById(id);
const el = {
  stateBadge: $("stateBadge"), simBadge: $("simBadge"), connDot: $("connDot"),
  abortBtn: $("abortBtn"), dro: $("dro"), coordBtn: $("coordBtn"),
  leadNote: $("leadNote"), modeSeg: $("modeSeg"), mpgPane: $("mpgPane"),
  jogPane: $("jogPane"), stepSeg: $("stepSeg"), speedSeg: $("speedSeg"),
  wheelWrap: $("wheelWrap"), wheelSvg: $("wheelSvg"), rotor: $("wheelRotor"),
  ticks: $("ticks"), wheelHint: $("wheelHint"), jogPlus: $("jogPlus"),
  jogMinus: $("jogMinus"), homeBtn: $("homeBtn"), homeAllBtn: $("homeAllBtn"),
  zeroBtn: $("zeroBtn"), powerBtn: $("powerBtn"), vibeBtn: $("vibeBtn"),
  zeroHalfBtn: $("zeroHalfBtn"), halfDlg: $("halfDlg"), halfTitle: $("halfTitle"),
  halfTool: $("halfTool"), halfUseTool: $("halfUseTool"), halfDia: $("halfDia"),
  halfErr: $("halfErr"), halfMinus: $("halfMinus"), halfPlus: $("halfPlus"),
  halfCancel: $("halfCancel"),
  toast: $("toast"), lock: $("lockOverlay"),
};

function post(url, data, keepalive) {
  // keepalive=true lets the request outlive the page (used for jog stop)
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {}),
    keepalive: !!keepalive,
  }).then((r) => r.json()).catch(() => ({ ok: false, msg: "network error" }));
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3500);
}

function buzz(n) {
  if (!settings.vibrate || !navigator.vibrate) return;
  if (n <= 1) { navigator.vibrate(8); return; }
  const pattern = [];
  for (let i = 0; i < Math.min(n, 5); i++) pattern.push(8, 35);
  navigator.vibrate(pattern);
}

/* ---------------------------------------------------------------- state -- */
let st = { connected: false, axes: null };
let axesList = [];
let lastErrN = null;      // null = no error counter seen yet
let lastFrame = 0;        // Date.now() of the last SSE frame
const STALE_MS = 1500;    // server streams at 10 Hz; this much silence = link lost
let sse = null;

function onFrame(ev) {
  st = JSON.parse(ev.data);
  lastFrame = Date.now();
  el.lock.hidden = true;
  if (!axesList.length && st.axes) {
    axesList = Object.keys(st.axes);
    if (!axesList.includes(settings.axis)) settings.axis = axesList[0];
    buildDro();
  }
  // disconnected frames carry no counter: seed from the first frame that
  // does, so an old error is never replayed as new (page load or reconnect)
  if (st.err_n !== undefined) {
    if (lastErrN === null) lastErrN = st.err_n;
    else if (st.err_n !== lastErrN) {
      lastErrN = st.err_n;
      if (st.err_text) toast(st.err_text);
    }
  }
  render();
}
function connectStream() {
  if (sse) sse.close();
  sse = new EventSource("api/stream");
  sse.onmessage = onFrame;
  sse.onerror = linkLost;   // after an error EventSource retries by itself
}
function linkLost() {
  st.connected = false;
  st.jog_ok = false;
  st.link_lost = true;
  el.lock.hidden = false;
  stopJog();
  render();
}
connectStream();
// A half-open connection (Wi-Fi drop, phone asleep) raises no error for a
// long time and EventSource would sit in OPEN forever. Treat silence as a
// lost link: release a held jog client-side, grey out, and reconnect.
setInterval(() => {
  if (lastFrame && !st.link_lost && Date.now() - lastFrame > STALE_MS) {
    linkLost();
    connectStream();
  }
}, 500);

/* ----------------------------------------------------------------- DRO -- */
function buildDro() {
  el.dro.innerHTML = "";
  axesList.forEach((a) => {
    const row = document.createElement("div");
    row.className = "dro-row";
    row.dataset.axis = a;
    row.innerHTML =
      '<span class="dro-axis">' + a.toUpperCase() + "</span>" +
      '<span class="dro-val">+0000.000</span>' +
      '<span class="homed-dot"></span>';
    row.addEventListener("pointerdown", () => {
      settings.axis = a;
      saveSettings();
      render();
    });
    el.dro.appendChild(row);
  });
}

function fmt(v) {
  const sign = v < 0 ? "\u2212" : "\u00a0";
  return sign + Math.abs(v).toFixed(3).padStart(8, "\u00a0");
}

/* -------------------------------------------------------------- render -- */
function render() {
  const c = st.connected;
  el.connDot.classList.toggle("ok", !!c);

  el.stateBadge.className = "badge";
  if (!c) {
    el.stateBadge.textContent =
      st.sim === false && !st.link_lost ? "waiting for LinuxCNC" : "no link";
  }
  else if (st.estop) { el.stateBadge.textContent = "E-STOP"; el.stateBadge.classList.add("estop"); }
  else if (!st.on) { el.stateBadge.textContent = "machine off"; el.stateBadge.classList.add("warn"); }
  else if (!st.idle) { el.stateBadge.textContent = "program running"; el.stateBadge.classList.add("warn"); }
  else { el.stateBadge.textContent = st.homed_all ? "ready" : "ready \u00b7 not homed"; el.stateBadge.classList.add("ok"); }

  el.simBadge.hidden = !st.sim;

  if (st.axes) {
    el.dro.querySelectorAll(".dro-row").forEach((row) => {
      const a = row.dataset.axis;
      const ax = st.axes[a];
      row.classList.toggle("sel", a === settings.axis);
      row.querySelector(".dro-val").textContent =
        fmt(settings.coord === "work" ? ax.work : ax.mach);
      row.querySelector(".homed-dot").classList.toggle("on", ax.homed);
    });
  }
  el.coordBtn.textContent = settings.coord;

  const jogOk = c && st.jog_ok;
  el.wheelWrap.classList.toggle("disabled", !jogOk);
  el.wheelHint.textContent = !c ? "no connection"
    : st.estop ? "e-stop active"
    : !st.on ? "machine off"
    : !st.idle ? "program running" : "";
  el.jogPlus.disabled = el.jogMinus.disabled = !jogOk;

  const A = settings.axis.toUpperCase();
  el.homeBtn.textContent = "Home " + A;
  el.zeroBtn.textContent = "Zero " + A;
  el.zeroHalfBtn.textContent = "Zero " + A + " \u00bd\u00d8";
  el.powerBtn.textContent = st.on ? "Machine off" : "Machine on";
  el.powerBtn.classList.toggle("off", !st.on);

  el.mpgPane.hidden = settings.mode !== "mpg";
  el.jogPane.hidden = settings.mode !== "jog";
  el.modeSeg.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === settings.mode));
  el.stepSeg.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", parseFloat(b.dataset.step) === settings.step));
  el.speedSeg.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", parseFloat(b.dataset.speed) === settings.speed));

  el.vibeBtn.textContent = navigator.vibrate
    ? (settings.vibrate ? "Vibration on" : "Vibration off")
    : "No vibration";
  el.vibeBtn.classList.toggle("off", !settings.vibrate || !navigator.vibrate);
}

/* --------------------------------------------------------------- wheel -- */
(function buildTicks() {
  // one tick per detent, derived from DETENT_DEG so the two never disagree
  const NS = "http://www.w3.org/2000/svg";
  const n = Math.max(1, Math.round(360 / DETENT_DEG));
  const majorEvery = n % 4 === 0 ? n / 4 : n;   // four major ticks when possible
  for (let i = 0; i < n; i++) {
    const ang = (i * DETENT_DEG * Math.PI) / 180;
    const major = i % majorEvery === 0;
    const r1 = 100, r2 = major ? 122 : 114;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", 160 + r1 * Math.sin(ang));
    line.setAttribute("y1", 160 - r1 * Math.cos(ang));
    line.setAttribute("x2", 160 + r2 * Math.sin(ang));
    line.setAttribute("y2", 160 - r2 * Math.cos(ang));
    if (major) line.setAttribute("class", "major");
    el.ticks.appendChild(line);
  }
})();

let wheelAngle = 0;       // accumulated visual angle, degrees
let emittedDetents = 0;   // detents already queued/sent
let detentQueue = 0;      // not yet flushed to the server
let tracking = false;
let lastPointerAngle = 0;
let activePointer = null;

function pointerAngle(ev) {
  const r = el.wheelSvg.getBoundingClientRect();
  const x = ev.clientX - (r.left + r.width / 2);
  const y = ev.clientY - (r.top + r.height / 2);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
function angleDiff(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

el.wheelWrap.addEventListener("pointerdown", (ev) => {
  if (!st.jog_ok || tracking) return;
  tracking = true;
  activePointer = ev.pointerId;
  lastPointerAngle = pointerAngle(ev);
  el.wheelWrap.setPointerCapture(ev.pointerId);
  requestWakeLock();
});

el.wheelWrap.addEventListener("pointermove", (ev) => {
  if (!tracking || ev.pointerId !== activePointer) return;
  const a = pointerAngle(ev);
  wheelAngle += angleDiff(a, lastPointerAngle);
  lastPointerAngle = a;
  el.rotor.setAttribute("transform", `rotate(${wheelAngle % 360} 160 160)`);

  // detent crossings, with one-detent backlash like a real wheel
  const pos = wheelAngle / DETENT_DEG;
  let crossed = 0;
  while (pos - emittedDetents >= 1) { emittedDetents++; crossed++; }
  while (emittedDetents - pos >= 1) { emittedDetents--; crossed--; }
  if (crossed !== 0) {
    detentQueue += crossed;
    buzz(Math.abs(crossed));
  }
});

function endWheel(ev) {
  if (!tracking || (ev && ev.pointerId !== activePointer)) return;
  tracking = false;
  activePointer = null;
  flushWheel();
}
el.wheelWrap.addEventListener("pointerup", endWheel);
el.wheelWrap.addEventListener("pointercancel", endWheel);

let flushing = false;
function flushWheel() {
  if (detentQueue === 0 || flushing) return;
  const send = detentQueue;
  detentQueue = 0;
  flushing = true;
  post("api/wheel", {
    axis: settings.axis,
    detents: send,
    increment: settings.step,
    velocity: WHEEL_FEED,
  }).then((r) => {
    flushing = false;
    if (!r.ok && r.msg) toast(r.msg);
    if (r.clamped) {
      el.leadNote.textContent = "wheel ahead of axis \u2014 extra clicks dropped";
      clearTimeout(flushWheel._t);
      flushWheel._t = setTimeout(() => { el.leadNote.textContent = ""; }, 1200);
    }
  });
}
setInterval(flushWheel, WHEEL_FLUSH_MS);

/* -------------------------------------------------------- continuous jog -- */
let jogHeld = null;      // button element while held
let keepaliveTimer = null;
let jogSeq = 0;          // bumped on every start/stop so a late start reply is ignored

function startJog(btn, dir) {
  if (!st.jog_ok || jogHeld) return;
  jogHeld = btn;
  const seq = ++jogSeq;
  btn.classList.add("held");
  requestWakeLock();
  post("api/jog", {
    action: "start", axis: settings.axis, dir, velocity: settings.speed,
  }).then((r) => {
    if (seq !== jogSeq || jogHeld !== btn) {
      // released before the start round-trip finished: make sure the server
      // is stopped too, and never start a keepalive that nobody will clear
      post("api/jog", { action: "stop" }, true);
      return;
    }
    if (!r.ok) { stopJog(); if (r.msg) toast(r.msg); return; }
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      post("api/jog", { action: "keepalive" }).then((k) => {
        // the server deadman already ended this jog -> release the button
        if (k.ok && !k.active && jogHeld) stopJog();
      });
    }, KEEPALIVE_MS);
  });
}

function stopJog() {
  clearInterval(keepaliveTimer);   // always, even if no button is held
  keepaliveTimer = null;
  if (!jogHeld) return;
  jogSeq++;
  jogHeld.classList.remove("held");
  jogHeld = null;
  post("api/jog", { action: "stop" }, true);
}

[[el.jogPlus, 1], [el.jogMinus, -1]].forEach(([btn, dir]) => {
  btn.addEventListener("pointerdown", (ev) => {
    btn.setPointerCapture(ev.pointerId);
    startJog(btn, dir);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) =>
    btn.addEventListener(t, stopJog));
});

/* if the tab hides or closes mid-jog, stop client-side too
   (the server deadman stops the machine regardless) */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopJog(); flushWheel(); }
  else requestWakeLock();
});
window.addEventListener("pagehide", stopJog);

/* -------------------------------------------------------------- controls -- */
el.modeSeg.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  stopJog();
  settings.mode = b.dataset.mode;
  saveSettings();
  render();
});
el.stepSeg.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  settings.step = parseFloat(b.dataset.step);
  saveSettings();
  render();
});
el.speedSeg.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  settings.speed = parseFloat(b.dataset.speed);
  saveSettings();
  render();
});
el.coordBtn.addEventListener("click", () => {
  settings.coord = settings.coord === "work" ? "mach" : "work";
  saveSettings();
  render();
});
el.vibeBtn.addEventListener("click", () => {
  settings.vibrate = !settings.vibrate;
  saveSettings();
  if (settings.vibrate) buzz(1);
  render();
});
el.abortBtn.addEventListener("click", () => {
  detentQueue = 0;
  stopJog();
  post("api/machine", { action: "abort" })
    .then((r) => { if (!r.ok) toast(r.msg || "abort not delivered"); });
});
el.powerBtn.addEventListener("click", () => {
  post("api/machine", { action: st.on ? "off" : "on" })
    .then((r) => { if (!r.ok && r.msg) toast(r.msg); });
});
el.homeBtn.addEventListener("click", () => {
  post("api/machine", { action: "home", axis: settings.axis })
    .then((r) => { if (!r.ok && r.msg) toast(r.msg); });
});
el.homeAllBtn.addEventListener("click", () => {
  post("api/machine", { action: "home" })
    .then((r) => { if (!r.ok && r.msg) toast(r.msg); });
});
el.zeroBtn.addEventListener("click", () => {
  post("api/machine", { action: "zero", axis: settings.axis })
    .then((r) => { if (!r.ok && r.msg) toast(r.msg); });
});

/* -------------------------------------------- zero at edge, half tool dia -- */
function openHalfDlg() {
  if (!st.jog_ok) { toast("machine not ready"); return; }
  const A = settings.axis.toUpperCase();
  el.halfTitle.textContent = "Zero " + A + " at edge (\u00bd tool \u00d8)";
  el.halfMinus.textContent = "Set " + A + " = \u2212\u00bd\u00d8";
  el.halfPlus.textContent = "Set " + A + " = +\u00bd\u00d8";
  const t = st.tool || {};
  const hasTool = t.id > 0 && t.dia > 0;
  el.halfUseTool.hidden = !hasTool;
  el.halfTool.textContent = hasTool
    ? "Tool " + t.id + " loaded \u00b7 \u00d8 " + t.dia.toFixed(3) + " mm"
    : (t.id > 0 ? "Tool " + t.id + " loaded, no diameter in tool table"
                : "No tool loaded \u2014 enter the diameter");
  el.halfDia.value = hasTool ? t.dia : settings.toolDia;
  el.halfErr.hidden = true;
  el.halfDlg.hidden = false;
}
function closeHalfDlg() { el.halfDlg.hidden = true; }
function applyHalf(side) {
  const d = parseFloat(el.halfDia.value);
  if (!(d > 0)) { el.halfErr.hidden = false; return; }
  el.halfErr.hidden = true;
  settings.toolDia = d;
  saveSettings();
  post("api/machine", {
    action: "zero_half", axis: settings.axis, diameter: d, side,
  }).then((r) => {
    if (!r.ok) { if (r.msg) toast(r.msg); return; }
    closeHalfDlg();
  });
}
el.zeroHalfBtn.addEventListener("click", openHalfDlg);
el.halfUseTool.addEventListener("click", () => {
  if (st.tool && st.tool.dia > 0) el.halfDia.value = st.tool.dia;
  el.halfErr.hidden = true;
});
el.halfDia.addEventListener("input", () => { el.halfErr.hidden = true; });
el.halfMinus.addEventListener("click", () => applyHalf(-1));
el.halfPlus.addEventListener("click", () => applyHalf(1));
el.halfCancel.addEventListener("click", closeHalfDlg);
el.halfDlg.addEventListener("pointerdown", (ev) => {
  if (ev.target === el.halfDlg) closeHalfDlg();
});

document.addEventListener("contextmenu", (ev) => ev.preventDefault());

/* ------------------------------------------------------------- wake lock -- */
let wakeLock = null;
function requestWakeLock() {
  if (wakeLock || !navigator.wakeLock) return;   // needs https or localhost
  navigator.wakeLock.request("screen")
    .then((wl) => {
      wakeLock = wl;
      wl.addEventListener("release", () => { wakeLock = null; });
    })
    .catch(() => {});
}

render();
