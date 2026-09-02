> Full documentation is in README.md — this file is the short install card.

# MPG pendant for linuxcnc-web — install & use

Needs LinuxCNC 2.9 or newer (Python 3 bindings) and Python 3 + Flask.

## 1. Install

After `git clone https://github.com/Coffee0297/linuxcnc-web.git` everything is
in place: `mpg/` is the whole pendant (backend blueprint + page + JS/CSS,
self-contained, touches nothing in `api/` or `client/`), `app.py` registers
it, and `standalone_mpg.py` runs only the pendant for testing anywhere.

To add the pendant to an existing linuxcnc-web checkout instead, copy the
`mpg/` folder next to `app.py` and add these two lines to it:

    from mpg.mpg import mpg_bp            # with the other imports
    app.register_blueprint(mpg_bp, url_prefix="/mpg")   # after the other blueprints

## 2. Try it on Windows first (simulator)

On Windows or macOS the pendant runs its built-in simulator when the `linuxcnc`
module is missing (on Linux set `MPG_SIM=1` to ask for it explicitly; a missing
module there is treated as an error), so the whole UI — wheel, detent vibration, jog mode —
can be tested from your phone before anything touches the machine.

    pip install flask
    python standalone_mpg.py

Phone on the same network → `http://<pc-ip>:5000/mpg/`
(allow Python through the Windows firewall for private networks if asked).

Vibration works in Chrome/Firefox on Android. iPhone: Safari has no
vibration API, so detents are visual only there.

## 3. On the CNC machine

Clone the repo on the Debian box (or copy your checkout there). With LinuxCNC running, from the repo dir:

    flask run --host=0.0.0.0

`--host=0.0.0.0` is required, otherwise Flask only listens on localhost and
the phone can't reach it. Then open `http://<cnc-ip>:5000/mpg/` on the phone.
LinuxCNC (2.9 or newer) must be running before `app.py` starts — the upstream
blueprints connect to it at import time. Only `standalone_mpg.py` can be
started earlier: its badge shows "waiting for LinuxCNC" and it reconnects by
itself.

Keep this on the shop LAN only — the Flask dev server has no authentication
and this page moves a machine. Do not port-forward it.

## 4. Using it

- Tap a DRO row to select the axis. Green dot = homed. `work`/`mach` toggles
  the coordinate readout.
- Wheel mode: pick the resolution (0.001 / 0.01 / 0.1 / 1.0 mm per detent)
  and turn. 24 detents per revolution, one vibration tick per detent.
- Jog mode: pick a speed (mm/min) and hold − / +. Release stops.
- Home X / Home all / Zero X (sets the current work offset to 0 via
  G10 L20) / Machine on-off / Abort.
- Zero X ½Ø — edge finding: touch the tool against the part edge and tap it.
  A popup asks for the tool diameter (pre-filled from the tool table when a
  tool with a diameter is loaded — "Use tool table Ø" copies it in) and which
  side you're touching from: coming from the − side sets the axis to −½Ø, so
  the edge itself reads zero. Nothing moves; it only sets the work offset.

## 5. Safety model — read this once

- The phone is **not an e-stop**. The wired e-stop chain stays the only
  safety device. Abort sends task-abort + jog-stop, nothing more.
- Continuous jog has a server-side deadman: the page sends a keepalive every
  150 ms; if the server hears nothing for 0.4 s (Wi-Fi drop, app killed,
  phone died) it stops the jog itself. Test this once for real: hold a jog,
  switch the phone to flight mode — the axis must stop within about half a
  second.
- The page itself treats 1.5 s of silence on the status stream as a lost
  link: it releases a held jog client-side and greys out.
- The stop of every held jog is checked; if LinuxCNC does not acknowledge it
  within 0.5 s the server also sends a task abort and the phone says so.
  Speed is capped at 600 mm/min until every joint is homed. Machine on,
  Home X and Home all need a 0.6 s hold. Zero refuses while an axis is
  still moving.
- The original page at / still reads the error channel while it is open and
  takes those messages away from AXIS; close it when AXIS is the operator GUI.
- Error toasts are off by default (the LinuxCNC error channel is a queue and
  the phone would steal messages from AXIS); start with `MPG_ERRORS=1` if the
  phone is your only GUI.
- The wheel sends bounded incremental jogs and is never allowed to run more
  than a few increments (max 2 mm) ahead of the axis. If you spin faster
  than the axis can follow, extra clicks are dropped and the page says so —
  that is deliberate: no stored-up motion can surprise you after a network
  stall.
- Jogging is refused while a program is running, in e-stop, or with the
  machine off — checked on the server, not just in the UI.

## 6. Tuning

Top of `mpg/mpg.py`: `AXES` (add `"a"` for a 4th axis — the UI follows
automatically), deadman timeout, wheel lead cap, `UNHOMED_MAX_MM_MIN` speed cap
before homing, poll rates. Environment: `MPG_SIM=1` simulator, `MPG_ERRORS=1`
error toasts.
Top of `mpg/static/mpg.js`: detent angle, wheel feed rate.
Speed/step button values: `mpg/templates/mpg.html`.

Screen staying on: the Wake Lock API needs HTTPS, which a plain LAN Flask
server doesn't have — set the phone's display timeout higher for now.

License: GPL-2.0, same as linuxcnc-web.
