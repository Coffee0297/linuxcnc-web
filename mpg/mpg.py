# MPG / jog pendant blueprint for linuxcnc-web
# License: GPL-2.0 (same as linuxcnc-web)
#
# Self-contained: drop this mpg/ folder next to app.py and register with
#   from mpg.mpg import mpg_bp
#   app.register_blueprint(mpg_bp, url_prefix="/mpg")
#
# Talks to LinuxCNC through the `linuxcnc` python module when available.
# On any other machine (Windows dev PC, etc.) it runs a built-in simulator
# so the page can be tested end to end, including from a phone.

import json
import math
import os
import sys
import threading
import time
import traceback

from flask import Blueprint, Response, jsonify, render_template, request

try:
    import linuxcnc
except Exception:
    linuxcnc = None

# Simulator policy: simulate when asked (MPG_SIM=1) or on a non-Linux dev PC.
# On Linux a missing linuxcnc module most likely means a mis-launched pendant
# on the real controller (wrong python, environment not sourced). Simulating
# silently there would let touch-offs "succeed" without reaching the machine.
SIM = os.environ.get("MPG_SIM") == "1" or (linuxcnc is None and sys.platform != "linux")
if linuxcnc is None and not SIM:
    raise ImportError(
        "mpg: the 'linuxcnc' python module is not importable. Start from the "
        "LinuxCNC environment, or set MPG_SIM=1 to run the built-in simulator."
    )

mpg_bp = Blueprint(
    "mpg", __name__, template_folder="templates", static_folder="static"
)

# ---------------------------------------------------------------- tuning ----
AXES = ["x", "y", "z"]        # pendant axes, extend with "a" if needed
AXIS_LETTERS = "xyzabcuvw"    # LinuxCNC axis index order
MAX_LEAD_FACTOR = 5           # wheel may run ahead of the axis by this many
MAX_LEAD_MM = 2.0             # increments, but never more than this many mm
CONT_TIMEOUT = 0.4            # s without keepalive -> continuous jog stops
WHEEL_TIMEOUT = 1.0           # s without wheel traffic -> lead target resets
POLL_HZ = 20                  # machine status poll rate
SSE_HZ = 10                   # state push rate to the phone
DEFAULT_MAX_VEL = 40.0        # units/s fallback if machine does not report
UNHOMED_MAX_MM_MIN = 600.0    # continuous-jog speed cap while not every joint is homed
READ_ERRORS = os.environ.get("MPG_ERRORS") == "1"   # error toasts, see _poll_real
STALE_WAIT = 0.5              # s: a wheel/jog request that waited longer for the lock is old news


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ------------------------------------------------------------- simulator ----
class SimMachine:
    """Small stand-in so the UI works without LinuxCNC."""

    def __init__(self):
        self.pos = {a: 0.0 for a in AXES}
        self.target = dict(self.pos)
        self.vel = {a: 0.0 for a in AXES}
        self.offset = {a: 0.0 for a in AXES}   # fake G5x
        self.homed = {a: False for a in AXES}
        self.on = True
        self.estop = False
        self.max_vel = 50.0  # units/s
        self.tool = {"id": 3, "dia": 6.0}  # pretend tool 3, 6 mm endmill

    def tick(self, dt):
        if not self.on or self.estop:
            for a in AXES:
                self.vel[a] = 0.0
                self.target[a] = self.pos[a]
            return
        for a in AXES:
            if self.vel[a]:
                self.pos[a] += self.vel[a] * dt
                self.target[a] = self.pos[a]
            else:
                d = self.target[a] - self.pos[a]
                step = clamp(d, -self.max_vel * dt, self.max_vel * dt)
                self.pos[a] += step


# ---------------------------------------------------------------- pendant ---
class Pendant:
    def __init__(self):
        self.lock = threading.RLock()
        self.sim = SIM
        self.machine = SimMachine() if self.sim else None
        self.stat = None
        self.cmd = None
        self.err = None
        self.connected = self.sim
        self.state = {"connected": False, "sim": self.sim}
        self.err_n = 0
        self.err_text = ""
        # wheel bookkeeping: commanded target per axis (units)
        self.wheel_target = {}
        self.wheel_seen = 0.0
        # continuous jog bookkeeping
        self.cont_axis = None
        self.cont_jjog = None        # joint/axis flag the running jog was started with
        self.cont_seq = None         # sequence number / client token of the running jog
        self.cont_client = None
        self.cont_deadline = 0.0
        self.last_stop_seq = {}      # per phone (page load): highest jog seq already stopped
        self.units = "mm"            # machine linear units as reported by LinuxCNC
        self.identity_kins = True    # axis letter n == joint n (plain XYZ trivkins)
        threading.Thread(target=self._loop, daemon=True).start()

    # ------------------------------------------------------------- loop ----
    def _loop(self):
        last = time.monotonic()
        while True:
            now = time.monotonic()
            dt, last = now - last, now
            try:
                with self.lock:
                    if self.sim:
                        self.machine.tick(dt)
                        self._build_state_sim()
                    else:
                        self._poll_real()
                    # deadman: stop continuous jog when keepalives stop
                    if self.cont_axis and now > self.cont_deadline:
                        self._stop_cont()
                    # forget wheel lead target when the wheel goes quiet
                    if self.wheel_target and now - self.wheel_seen > WHEEL_TIMEOUT:
                        self.wheel_target = {}
            except Exception:
                # This thread must never die: a dead loop would freeze the
                # state the phone sees (stale "ready") and disable the jog
                # deadman. Stop anything moving, report "no link", carry on.
                traceback.print_exc()
                with self.lock:
                    self._stop_cont()
                    self.wheel_target = {}
                    self.connected = False
                    self.state = {"connected": False, "sim": self.sim}
            time.sleep(1.0 / POLL_HZ)

    def _connect_real(self):
        try:
            self.stat = linuxcnc.stat()
            self.cmd = linuxcnc.command()
            self.err = linuxcnc.error_channel() if READ_ERRORS else None
            self.stat.poll()
            self.connected = True
        except Exception:
            self.stat = self.cmd = self.err = None
            self.connected = False

    def _poll_real(self):
        if not self.connected:
            self._connect_real()
            if not self.connected:
                self.state = {"connected": False, "sim": False}
                return
        try:
            self.stat.poll()
            if self.err is not None:
                # The NML error channel is a queue: a message read here is
                # gone for every other GUI (AXIS, gmoccapy), so the operator
                # at the machine would miss "joint on limit" and the like.
                # Off by default; MPG_ERRORS=1 enables it when the phone is
                # the only GUI in use.
                e = self.err.poll()
                if e:
                    self.err_n += 1
                    self.err_text = str(e[1])
            self._build_state_real()
        except Exception:
            # LinuxCNC went away (or one poll failed): try to stop a running
            # jog while the command channel may still work, then drop the
            # channels and retry next cycle
            self._stop_cont()
            self.stat = self.cmd = self.err = None
            self.connected = False
            self.state = {"connected": False, "sim": False}
            self.wheel_target = {}

    # ------------------------------------------------------------ state ----
    def _build_state_real(self):
        s = self.stat
        # Axis letter n is joint n only for plain trivkins (XYZ..., one motor
        # per axis). On a gantry (XYYZ) or a lathe (XZ) a joint-mode jog,
        # a per-axis home or s.homed[axis] would address the wrong motor, so
        # remember whether the mapping is the identity and act on it below.
        njoints = int(getattr(s, "joints", len(AXES)) or len(AXES))
        mask = int(getattr(s, "axis_mask", 0) or 0)
        kins_identity = getattr(linuxcnc, "KINEMATICS_IDENTITY", 1)
        kt = getattr(s, "kinematics_type", kins_identity)
        # identity only if the kinematics module says so AND the axes are
        # exactly the first n letters: a delta or scara with three joints
        # also reports an XYZ mask, and a lathe XZ has a gap in it
        self.identity_kins = kt == kins_identity and mask == (1 << njoints) - 1
        joints_homed = all(bool(h) for h in s.homed[:njoints])
        lu = float(getattr(s, "linear_units", 1.0) or 1.0)
        if abs(lu - 1.0) < 1e-6:
            self.units = "mm"
        elif abs(lu - 1 / 25.4) < 1e-4 or abs(lu - 25.4) < 1e-3:
            self.units = "in"
        else:
            self.units = "units"
        axes = {}
        # "all homed" means every joint: that is what LinuxCNC requires before
        # motion may enter teleop (world-mode jogging), and it is what lifts
        # the unhomed speed cap
        homed_all = joints_homed
        for a in AXES:
            i = AXIS_LETTERS.index(a)
            mach = s.actual_position[i]
            work = mach - s.g5x_offset[i] - s.g92_offset[i] - s.tool_offset[i]
            homed = bool(s.homed[i]) if self.identity_kins else joints_homed
            axes[a] = {"mach": mach, "work": work, "homed": homed}
        on = s.task_state == linuxcnc.STATE_ON
        estop = s.task_state == linuxcnc.STATE_ESTOP
        idle = s.interp_state == linuxcnc.INTERP_IDLE
        tool = {"id": 0, "dia": 0.0}
        try:
            t = s.tool_table[0]          # index 0 = the loaded tool
            if t.id > 0:
                tool = {"id": int(t.id), "dia": float(t.diameter)}
        except Exception:
            pass
        self.state = {
            "connected": True,
            "sim": False,
            "on": on,
            "estop": estop,
            "idle": idle,
            "jog_ok": on and not estop and idle,
            "homed_all": homed_all,
            "joint_mode": s.motion_mode == linuxcnc.TRAJ_MODE_FREE,
            "max_vel": s.max_velocity or DEFAULT_MAX_VEL,
            "units": self.units,
            "identity_kins": self.identity_kins,
            "axes": axes,
            "tool": tool,
            "err_n": self.err_n,
            "err_text": self.err_text,
        }

    def _build_state_sim(self):
        m = self.machine
        axes = {}
        for a in AXES:
            axes[a] = {
                "mach": m.pos[a],
                "work": m.pos[a] - m.offset[a],
                "homed": m.homed[a],
            }
        self.state = {
            "connected": True,
            "sim": True,
            "on": m.on,
            "estop": m.estop,
            "idle": True,
            "jog_ok": m.on and not m.estop,
            "homed_all": all(m.homed.values()),
            "joint_mode": not all(m.homed.values()),
            "max_vel": m.max_vel,
            "units": "mm",
            "identity_kins": True,
            "tool": dict(m.tool),
            "axes": axes,
            "err_n": self.err_n,
            "err_text": self.err_text,
        }

    def _refresh_locked(self):
        """Rebuild self.state right now (caller holds the lock).

        The poll loop only refreshes every 1/POLL_HZ s; command guards must
        not act on that stale snapshot.
        """
        if self.sim:
            self._build_state_sim()
        else:
            self._poll_real()
        return self.state

    # ------------------------------------------------- LinuxCNC helpers ----
    def _ensure_manual(self):
        self.stat.poll()
        if self.stat.task_mode != linuxcnc.MODE_MANUAL:
            self.cmd.mode(linuxcnc.MODE_MANUAL)
            self.cmd.wait_complete(1.0)

    def _jjog_prepare(self):
        """Return jog mode flag: 1 = joint jog, 0 = axis (teleop) jog.

        Before homing LinuxCNC only allows joint jogs; once every joint is
        homed we switch motion to teleop so world-axis jogging works.
        """
        s = self.stat
        s.poll()
        if s.motion_mode != linuxcnc.TRAJ_MODE_FREE:
            return 0
        njoints = int(getattr(s, "joints", len(AXES)) or len(AXES))
        if all(bool(h) for h in s.homed[:njoints]):
            try:
                self.cmd.teleop_enable(1)
                self.cmd.wait_complete(0.5)
                s.poll()
                if s.motion_mode != linuxcnc.TRAJ_MODE_FREE:
                    return 0
            except Exception:
                pass
        if not self.identity_kins:
            # a joint jog addressed by axis letter would move the wrong motor
            raise RuntimeError(
                "joint jog refused: axis letters do not map 1:1 to joints on "
                "this machine. Use 'Home all' first, then jog in world mode."
            )
        return 1

    def _jjog_current(self):
        """Joint/axis flag matching the CURRENT motion mode, without changing it."""
        self.stat.poll()
        return 1 if self.stat.motion_mode == linuxcnc.TRAJ_MODE_FREE else 0

    def _jog(self, jog_cmd, axis, *args, jjog=None):
        """Send a jog command and return the joint/axis flag it was sent with.

        jjog=None derives the flag from the machine state (switching to
        teleop when appropriate); a JOG_STOP must pass the flag its start
        used. Needs the LinuxCNC 2.9+ (Python 3) bindings: the old 2.7
        4-argument form would silently jog the wrong axis, so no fallback.
        """
        idx = AXIS_LETTERS.index(axis)
        if jjog is None:
            jjog = self._jjog_prepare()
        self.cmd.jog(jog_cmd, jjog, idx, *args)
        return jjog

    def _vel(self, mm_per_min):
        """units/min from the UI (mm/min on a metric machine) -> clamped units/s."""
        vmax = self.state.get("max_vel") or DEFAULT_MAX_VEL
        return clamp(abs(mm_per_min) / 60.0, 0.01, vmax)

    def _units_per_mm(self):
        """Scale factor for the mm-denominated constants (lead cap, speed cap)."""
        return 1 / 25.4 if self.units == "in" else 1.0

    # ------------------------------------------ jog sequence bookkeeping ----
    # The phone numbers its jogs; a start whose stop the server has already
    # processed must not begin motion. Marks are kept per client token (one
    # per page load) because the phone's counter restarts on every reload
    # and two phones count independently.
    STOP_MARK_TTL = 600.0     # s: forget a client's mark after this long
    STOP_MARK_MAX = 100       # clients remembered at most
    STOP_MARK_FRESH = 5.0     # s: never evict a mark this young (the reorder window)

    def _stop_mark(self, client):
        entry = self.last_stop_seq.get(client)
        return entry[0] if entry else -1

    def _record_mark(self, client, seq):
        """Raise a client's mark: the highest seq seen in a START or a stop.

        A start at or below the mark is an old request arriving late - its
        release already happened (the phone never holds two jogs at once).
        """
        try:
            seq = int(seq)
        except (TypeError, ValueError, OverflowError):
            return
        if not client or not 0 <= seq < 2 ** 53:
            return
        now = time.monotonic()
        for k in [k for k, (_, t) in self.last_stop_seq.items()
                  if now - t > self.STOP_MARK_TTL]:
            del self.last_stop_seq[k]
        while len(self.last_stop_seq) >= self.STOP_MARK_MAX and client not in self.last_stop_seq:
            oldest = min(self.last_stop_seq, key=lambda k: self.last_stop_seq[k][1])
            if now - self.last_stop_seq[oldest][1] < self.STOP_MARK_FRESH:
                break   # all recent: grow a little rather than forget a live phone
            del self.last_stop_seq[oldest]
        self.last_stop_seq[client] = (max(self._stop_mark(client), seq), now)

    # ------------------------------------------------------------ wheel ----
    def wheel(self, axis, detents, increment, mm_per_min):
        t0 = time.monotonic()
        with self.lock:
            if time.monotonic() - t0 > STALE_WAIT:
                # queued behind a long action while the phone already gave up
                # on this request: never apply it late
                return {"ok": False, "applied": 0, "msg": "stale wheel input dropped"}
            st = self._refresh_locked()
            if axis not in AXES or not st.get("jog_ok"):
                return {"ok": False, "applied": 0, "msg": "jog not allowed"}
            try:
                detents = float(detents)
                increment = float(increment)
                mm_per_min = float(mm_per_min)
            except (TypeError, ValueError, OverflowError):
                return {"ok": False, "applied": 0, "msg": "bad request"}
            if not (math.isfinite(detents) and abs(detents) <= 10000
                    and math.isfinite(increment) and increment > 0
                    and math.isfinite(mm_per_min)):
                return {"ok": False, "applied": 0, "msg": "bad request"}
            detents = int(detents)
            if detents == 0:
                return {"ok": True, "applied": 0}
            if self.cont_axis and not self._stop_cont():
                return {"ok": False, "applied": 0, "msg": "jog stop failed - abort sent"}
            actual = st["axes"][axis]["mach"]
            # a fresh gesture (or axis change) starts from where the axis is
            self.wheel_target = {axis: self.wheel_target.get(axis, actual)}
            self.wheel_seen = time.monotonic()
            max_lead = min(MAX_LEAD_MM * self._units_per_mm(), MAX_LEAD_FACTOR * increment)
            lead = self.wheel_target[axis] - actual
            new_lead = clamp(lead + detents * increment, -max_lead, max_lead)
            # Whole increments that still fit under the lead cap. Truncate
            # toward zero so clamping can never over-apply, but with a small
            # tolerance: 0.1+0.1+0.1 != 0.3 in floating point, and a plain
            # int() silently dropped legitimate detents (0.999... -> 0).
            q = (new_lead - lead) / increment
            applied = int(math.copysign(math.floor(abs(q) + 1e-6), q))
            if applied == 0:
                return {"ok": True, "applied": 0, "clamped": True}
            dist = applied * increment
            try:
                if self.sim:
                    self.machine.target[axis] += dist
                else:
                    self._ensure_manual()
                    self._jog(
                        linuxcnc.JOG_INCREMENT, axis, self._vel(mm_per_min), dist
                    )
                self.wheel_target[axis] += dist
                return {
                    "ok": True,
                    "applied": applied,
                    "clamped": applied != detents,
                }
            except Exception as exc:
                return {"ok": False, "applied": 0, "msg": str(exc)}

    # ------------------------------------------------- continuous jog ------
    def jog_start(self, axis, direction, mm_per_min, seq=None, client=None):
        t0 = time.monotonic()
        with self.lock:
            if time.monotonic() - t0 > STALE_WAIT:
                return {"ok": False, "msg": "stale start ignored"}
            st = self._refresh_locked()
            if axis not in AXES or not st.get("jog_ok"):
                return {"ok": False, "msg": "jog not allowed"}
            try:
                direction = float(direction)
                mm_per_min = float(mm_per_min)
                seq = None if seq is None else int(seq)
            except (TypeError, ValueError, OverflowError):
                return {"ok": False, "msg": "bad request"}
            if not (math.isfinite(direction) and direction != 0
                    and math.isfinite(mm_per_min)):
                return {"ok": False, "msg": "bad request"}   # no default direction
            if seq is not None and not 0 <= seq < 2 ** 53:
                return {"ok": False, "msg": "bad request"}
            if seq is not None and client and seq <= self._stop_mark(client):
                # its stop, or a NEWER start from the same phone, was already
                # processed (requests reordered on the wire): starting now
                # would move an axis nobody is holding the button for
                return {"ok": False, "msg": "stale start ignored"}
            if seq is not None:
                self._record_mark(client, seq)
            direction = 1 if direction > 0 else -1
            # never two continuous jogs at once: a jog left running on another
            # axis would have nobody watching it (the deadman only tracks one)
            if self.cont_axis and self.cont_axis != axis and not self._stop_cont():
                return {"ok": False, "msg": "previous jog stop failed - abort sent"}
            vel = self._vel(mm_per_min)
            limited = False
            if not st.get("homed_all"):
                # unhomed joints have no soft limits: keep the speed modest
                cap = self._vel(UNHOMED_MAX_MM_MIN * self._units_per_mm())
                if vel > cap:
                    vel, limited = cap, True
            try:
                jjog = None
                if self.sim:
                    self.machine.vel[axis] = direction * vel
                else:
                    self._ensure_manual()
                    jjog = self._jog(linuxcnc.JOG_CONTINUOUS, axis, direction * vel)
                self.cont_axis = axis
                self.cont_jjog = jjog
                self.cont_seq = seq
                self.cont_client = client
                self.cont_deadline = time.monotonic() + CONT_TIMEOUT
                return {"ok": True, "limited": limited}
            except Exception as exc:
                return {"ok": False, "msg": str(exc)}

    def jog_keepalive(self, seq=None, client=None):
        with self.lock:
            active = bool(self.cont_axis)
            if active and seq is not None:
                # only the phone holding THIS jog may keep it alive; a phone
                # whose jog was replaced learns it from active=false
                try:
                    active = client == self.cont_client and int(seq) == self.cont_seq
                except (TypeError, ValueError, OverflowError):
                    active = False
            if active:
                self.cont_deadline = time.monotonic() + CONT_TIMEOUT
            return {"ok": True, "active": active}

    def jog_stop(self, axis=None, seq=None, client=None):
        with self.lock:
            tracked = self.cont_axis
            # A stop that names an OLDER jog of the phone currently jogging
            # (release, quick re-press, then the first stop arrives late)
            # must not cut the fresh press; that jog has its own keepalives.
            stale = False
            if (seq is not None and client and client == self.cont_client
                    and self.cont_seq is not None):
                try:
                    s = int(seq)
                    stale = 0 <= s < self.cont_seq   # garbage (negative) is not "older": stop
                except (TypeError, ValueError, OverflowError):
                    stale = False
            # otherwise stop FIRST: nothing below may keep the stop from being sent
            ok = True if stale else self._stop_cont()
            if seq is not None:
                self._record_mark(client, seq)
            # belt and braces: also stop the axis the phone says it was
            # jogging, in case the server lost track of it
            if (not self.sim and axis in AXES and axis != tracked
                    and self.cmd is not None):
                try:
                    self._jog(linuxcnc.JOG_STOP, axis, jjog=self._jjog_current())
                except Exception:
                    traceback.print_exc()
            if ok:
                return {"ok": True}
            return {"ok": False, "msg": "jog stop failed - abort sent"}

    def _stop_cont(self):
        """Stop the tracked continuous jog.

        Returns True when nothing was running or the stop was acknowledged,
        False when it had to escalate to a task abort.
        """
        axis, self.cont_axis = self.cont_axis, None
        jjog, self.cont_jjog = self.cont_jjog, None
        self.cont_seq = self.cont_client = None
        if not axis:
            return True
        if self.sim:
            self.machine.vel[axis] = 0.0
            self.machine.target[axis] = self.machine.pos[axis]
            return True
        try:
            # Stop in exactly the mode the jog was started in; deriving it
            # again here could flip teleop mid-motion and miss the stop.
            # wait_complete: RCS_DONE = acknowledged, RCS_ERROR = rejected,
            # -1 = no echo in time. The echo can be missed when another
            # sender (halui, a panel) issues a command at the same moment,
            # so the stop is retried once before escalating.
            for _attempt in range(2):
                self._jog(linuxcnc.JOG_STOP, axis, jjog=jjog)
                if self.cmd.wait_complete(0.5) == linuxcnc.RCS_DONE:
                    return True
            raise RuntimeError("JOG_STOP not acknowledged by task")
        except Exception:
            traceback.print_exc()
            # the one command that must never fail quietly: a task abort ends
            # every jog and every motion
            try:
                self.cmd.abort()
            except Exception:
                traceback.print_exc()
            return False

    # ---------------------------------------------------------- actions ----
    def action(self, name, axis=None, extra=None):
        with self.lock:
            # every machine action ends a running continuous jog first: the
            # mode switches and waits below hold the lock for seconds, and a
            # jog must never keep going while nobody can stop it
            if not self._stop_cont() and name != "abort":
                return {"ok": False, "msg": "jog stop failed - abort sent"}
            self._refresh_locked()
            if not self.sim and (not self.connected or self.cmd is None):
                return {"ok": False, "msg": "not connected to LinuxCNC"}
            try:
                if self.sim:
                    result = self._action_sim(name, axis, extra or {})
                else:
                    result = self._action_real(name, axis, extra or {})
            except Exception as exc:
                return {"ok": False, "msg": str(exc)}
            self._refresh_locked()
            return result

    @staticmethod
    def _zero_value(name, extra):
        """Work-offset value for zero actions: 0, or a signed half diameter."""
        if name == "zero":
            return 0.0
        try:
            dia = float(extra.get("diameter", 0))
            side = 1 if int(extra.get("side", 1)) >= 0 else -1
        except (TypeError, ValueError):
            return None
        if not 0 < dia < 500:
            return None
        return side * dia / 2.0

    def _action_real(self, name, axis, extra):
        c = self.cmd
        if name == "abort":
            self._stop_cont()
            self.wheel_target = {}
            c.abort()
        elif name == "on":
            c.state(linuxcnc.STATE_ESTOP_RESET)
            c.wait_complete(1.0)
            c.state(linuxcnc.STATE_ON)
        elif name == "off":
            self._stop_cont()
            c.state(linuxcnc.STATE_OFF)
        elif name == "home":
            if not self.state.get("jog_ok"):
                return {"ok": False, "msg": "machine busy"}
            if axis in AXES and not self.identity_kins:
                return {"ok": False, "msg": "per-axis homing not available on "
                                            "this kinematics - use Home all"}
            self._ensure_manual()
            c.teleop_enable(0)
            c.wait_complete(0.5)
            c.home(AXIS_LETTERS.index(axis) if axis in AXES else -1)
        elif name in ("zero", "zero_half"):
            if not self.state.get("jog_ok"):
                return {"ok": False, "msg": "machine busy"}
            if axis not in AXES:
                return {"ok": False, "msg": "no axis"}
            value = self._zero_value(name, extra)
            if value is None:
                return {"ok": False, "msg": "bad tool diameter"}
            self.stat.poll()
            if not getattr(self.stat, "inpos", True):
                # a touch-off taken from a moving axis is a wrong offset
                return {"ok": False, "msg": "axis still moving - wait, then zero"}
            c.mode(linuxcnc.MODE_MDI)
            c.wait_complete(1.0)
            c.mdi(f"G10 L20 P0 {axis.upper()}{value:.4f}")
            c.wait_complete(2.0)
            c.mode(linuxcnc.MODE_MANUAL)
            c.wait_complete(1.0)
        else:
            return {"ok": False, "msg": f"unknown action {name}"}
        return {"ok": True}

    def _action_sim(self, name, axis, extra):
        m = self.machine
        if name == "abort":
            self._stop_cont()
            self.wheel_target = {}
            for a in AXES:
                m.target[a] = m.pos[a]
        elif name == "on":
            m.estop = False
            m.on = True
        elif name == "off":
            self._stop_cont()
            m.on = False
        elif name == "home":
            if not self.state.get("jog_ok"):
                return {"ok": False, "msg": "machine busy"}
            targets = [axis] if axis in AXES else AXES
            for a in targets:
                m.pos[a] = m.target[a] = 0.0
                m.homed[a] = True
        elif name in ("zero", "zero_half"):
            if axis not in AXES:
                return {"ok": False, "msg": "no axis"}
            value = self._zero_value(name, extra)
            if value is None:
                return {"ok": False, "msg": "bad tool diameter"}
            if any(m.vel[a] or abs(m.target[a] - m.pos[a]) > 1e-9 for a in AXES):
                return {"ok": False, "msg": "axis still moving - wait, then zero"}
            m.offset[axis] = m.pos[axis] - value
        else:
            return {"ok": False, "msg": f"unknown action {name}"}
        return {"ok": True}


PENDANT = Pendant()


# ----------------------------------------------------------------- routes ---
def _body():
    """JSON object from the request, or {} for anything else (no 500s)."""
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


@mpg_bp.route("/")
def page():
    return render_template("mpg.html")


@mpg_bp.route("/api/state")
def api_state():
    return jsonify(PENDANT.state)


@mpg_bp.route("/api/stream")
def api_stream():
    def gen():
        while True:
            yield "data: " + json.dumps(PENDANT.state) + "\n\n"
            time.sleep(1.0 / SSE_HZ)

    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@mpg_bp.route("/api/wheel", methods=["POST"])
def api_wheel():
    d = _body()
    return jsonify(
        PENDANT.wheel(
            d.get("axis"),
            d.get("detents", 0),
            d.get("increment", 0),
            d.get("velocity", 3000),
        )
    )


@mpg_bp.route("/api/jog", methods=["POST"])
def api_jog():
    d = _body()
    act = d.get("action")
    client = str(d.get("client") or "")[:64] or None   # one token per page load
    if act == "start":
        return jsonify(
            PENDANT.jog_start(
                d.get("axis"), d.get("dir", 1), d.get("velocity", 600),
                d.get("seq"), client,
            )
        )
    if act == "keepalive":
        return jsonify(PENDANT.jog_keepalive(d.get("seq"), client))
    if act == "stop":
        return jsonify(PENDANT.jog_stop(d.get("axis"), d.get("seq"), client))
    return jsonify({"ok": False, "msg": "unknown jog action"})


@mpg_bp.route("/api/machine", methods=["POST"])
def api_machine():
    d = _body()
    return jsonify(PENDANT.action(d.get("action"), d.get("axis"), d))
