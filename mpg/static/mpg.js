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

function post(url, data, keepalive, signal) {
  // keepalive=true lets the request outlive the page (used for jog stop);
  // signal lets the caller abort a request that is taking too long
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {}),
    keepalive: !!keepalive,
    signal,
  }).then((r) => r.json()).catch((e) => ({
    ok: false, aborted: !!(e && e.name === "AbortError"), msg: "network error",
  }));
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
  discardWheel();
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
      if (tracking || jogHeld) return;   // never re-target a gesture in progress
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
  if (!jogOk && jogHeld) stopJog();   // release first: a disabled button may swallow pointerup
  el.jogPlus.disabled = el.jogMinus.disabled = !jogOk;
  const u = st.units || "mm";
  document.querySelectorAll("[data-unit]").forEach((n) => {
    n.textContent = n.dataset.unit === "per-min" ? u + "/min" : u;
  });

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
let queueAxis = null;     // axis and step the queued detents were made under
let queueStep = 0;
let queueSince = 0;       // Date.now() of the first detent in the queue
const QUEUE_MAX_AGE_MS = 300;      // older queued detents are dropped, never replayed
const WHEEL_POST_TIMEOUT_MS = 600; // a wheel request slower than this is abandoned

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
    if (detentQueue === 0) {
      queueAxis = settings.axis;
      queueStep = settings.step;
      queueSince = Date.now();
    }
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
el.wheelWrap.addEventListener("lostpointercapture", endWheel);

let flushing = false;
function showLeadNote(text) {
  el.leadNote.textContent = text;
  clearTimeout(showLeadNote._t);
  showLeadNote._t = setTimeout(() => { el.leadNote.textContent = ""; }, 1500);
}
function discardWheel(why) {
  if (detentQueue === 0) return;
  detentQueue = 0;
  if (why) showLeadNote(why);
}
function flushWheel() {
  if (detentQueue === 0) return;
  if (Date.now() - queueSince > QUEUE_MAX_AGE_MS) {
    // clicks that waited behind a stalled link must never become motion later
    discardWheel("link stalled \u2014 wheel input discarded");
    return;
  }
  if (flushing) return;
  // send the detents under the axis/step they were made with, not the
  // current selection (the other thumb may have changed it meanwhile)
  const send = detentQueue, axis = queueAxis, increment = queueStep;
  detentQueue = 0;
  flushing = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WHEEL_POST_TIMEOUT_MS);
  post("api/wheel", { axis, detents: send, increment, velocity: WHEEL_FEED }, false, ctl.signal)
    .then((r) => {
      if (r.aborted) {
        // the server drops a request that waited too long for its turn
        // (STALE_WAIT), so nothing stored up can move later
        discardWheel();
        showLeadNote("wheel reply late \u2014 input discarded");
        return;
      }
      if (!r.ok && r.msg) toast(r.msg);
      if (r.clamped) showLeadNote("wheel ahead of axis \u2014 extra clicks dropped");
    })
    .finally(() => { clearTimeout(timer); flushing = false; });
}
setInterval(flushWheel, WHEEL_FLUSH_MS);

/* -------------------------------------------------------- continuous jog -- */
let jogHeld = null;      // button element while held
let jogAxis = null;      // axis of the held jog (sent with its stop)
let heldSeq = 0;         // sequence number of the held jog
let keepaliveTimer = null;
let jogSeq = 0;          // every start gets a new number; the server refuses a
                         // start whose stop it has already processed ...
// ... scoped to this page load: the server keeps one high-water mark per
// client token, so a reload or a second phone starts with a clean slate
const CLIENT = Math.random().toString(36).slice(2) + Date.now().toString(36);

function startJog(btn, dir) {
  if (!st.jog_ok || jogHeld) return;
  const axis = settings.axis;
  const seq = ++jogSeq;
  jogHeld = btn;
  jogAxis = axis;
  heldSeq = seq;
  btn.classList.add("held");
  requestWakeLock();
  post("api/jog", {
    action: "start", axis, dir, velocity: settings.speed, seq, client: CLIENT,
  }).then((r) => {
    if (heldSeq !== seq || jogHeld !== btn) {
      // released before the start round-trip finished: if the start went
      // through, make sure the server is stopped too (a refused start moved
      // nothing), and never start a keepalive that nobody will clear
      if (r.ok) post("api/jog", { action: "stop", axis, seq, client: CLIENT }, true);
      return;
    }
    if (!r.ok) { stopJog(); if (r.msg) toast(r.msg); return; }
    if (r.limited) toast("not homed — jog speed limited");
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      post("api/jog", { action: "keepalive", seq, client: CLIENT }).then((k) => {
        // the server deadman already ended THIS jog -> release the button;
        // a late reply about an older jog must not stop a fresh press
        if (k.ok && !k.active && heldSeq === seq) stopJog();
      });
    }, KEEPALIVE_MS);
  });
}

function stopJog() {
  clearInterval(keepaliveTimer);   // always, even if no button is held
  keepaliveTimer = null;
  if (!jogHeld) return;
  const axis = jogAxis, seq = heldSeq;
  jogHeld.classList.remove("held");
  jogHeld = null;
  jogAxis = null;
  heldSeq = 0;
  post("api/jog", { action: "stop", axis, seq, client: CLIENT }, true)
    .then((r) => { if (!r.ok) toast(r.msg || "jog stop failed"); });
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
  if (document.hidden) {
    stopJog();
    discardWheel();
    tracking = false;        // the pointerup may never arrive: end the gesture here
    activePointer = null;
  } else {
    requestWakeLock();
  }
});
window.addEventListener("pagehide", stopJog);

/* -------------------------------------------------------------- controls -- */
el.modeSeg.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b || tracking) return;
  stopJog();
  settings.mode = b.dataset.mode;
  saveSettings();
  render();
});
el.stepSeg.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b || tracking) return;   // no step change under a finger on the wheel
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
function sendAbort(retry) {
  discardWheel();
  stopJog();
  post("api/machine", { action: "abort" }).then((r) => {
    if (r.ok) return;
    if (retry) setTimeout(() => sendAbort(false), 300);
    else toast(r.msg || "abort not delivered");
  });
}
// pointerdown, not click: a panicked press must not wait for the finger to lift
el.abortBtn.addEventListener("pointerdown", () => sendAbort(true));

/* Energising the drives and homing every joint start power or motion from a
   phone that may be in a pocket: require a deliberate hold, not a tap. */
const HOLD_MS = 600;
function holdToConfirm(btn, needsHold, action) {
  let timer = null, pid = null;
  const cancel = (ev) => {
    if (pid === null || (ev && ev.pointerId !== pid)) return;
    pid = null;
    if (timer) { clearTimeout(timer); timer = null; toast("hold to confirm"); }
    btn.classList.remove("arming");
  };
  btn.addEventListener("pointerdown", (ev) => {
    if (pid !== null) return;   // a second finger can neither extend nor re-arm a hold
    if (!needsHold()) { action(false); return; }
    pid = ev.pointerId;
    btn.setPointerCapture(pid);
    btn.classList.add("arming");
    timer = setTimeout(() => { timer = null; btn.classList.remove("arming"); action(true); }, HOLD_MS);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => btn.addEventListener(t, cancel));
  // a hold must never complete on a page that went to the background
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
}
holdToConfirm(el.powerBtn, () => !st.on, (held) => {
  // decided when the finger went down: a completed hold is always "on",
  // an immediate press (button read "Machine off") is always "off"
  post("api/machine", { action: held ? "on" : "off" })
    .then((r) => { if (!r.ok && r.msg) toast(r.msg); });
});
holdToConfirm(el.homeBtn, () => true, () => {   // homing is motion too
  post("api/machine", { action: "home", axis: settings.axis })
    .then((r) => { if (!r.ok && r.msg) toast(r.msg); });
});
holdToConfirm(el.homeAllBtn, () => true, () => {
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
    ? "Tool " + t.id + " loaded \u00b7 \u00d8 " + t.dia.toFixed(3) + " " + (st.units || "mm")
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
