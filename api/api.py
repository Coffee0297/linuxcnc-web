import datetime
import math

import linuxcnc
from flask import Blueprint

AXIS_NAMES = ["X", "Y", "Z", "A", "B", "C", "U", "V", "W"]

s = linuxcnc.stat()
c = linuxcnc.command()
e = linuxcnc.error_channel()

tempdata = {
    "error_counter": 0,
    "errors": {},
    "mdi_commands": [],
}

api_bp = Blueprint("api_bp", __name__)

def mdi_blocker():
    s.poll()
    if s.estop:
        return "e-stop active"
    if not s.enabled:
        return "machine off"
    if s.homed.count(1) != s.joints:
        return "not homed"
    if s.interp_state != linuxcnc.INTERP_IDLE:
        return "interpreter busy"
    return None


@api_bp.route("/JogStart/<axis>/<speed>")
def do_JogStart(axis, speed):
    if axis in AXIS_NAMES:
        axis = AXIS_NAMES.index(axis)
    try:
        axis = int(axis)
        speed = int(speed)
    except ValueError:
        return ("bad parameter", 400)
    c.mode(linuxcnc.MODE_MANUAL)
    c.jog(linuxcnc.JOG_CONTINUOUS,  True, axis, speed)
    return "OK"

@api_bp.route("/JogStop/<axis>")
def do_JogStop(axis):
    if axis in AXIS_NAMES:
        axis = AXIS_NAMES.index(axis)
    try:
        axis = int(axis)
    except ValueError:
        return ("bad parameter", 400)
    c.jog(linuxcnc.JOG_STOP,  True, axis)
    return "OK"

@api_bp.route("/auto/<mode>")
def do_auto(mode):
    s.poll()
    if s.task_mode != linuxcnc.MODE_AUTO:
        c.mode(linuxcnc.MODE_AUTO)

    if mode == "RUN":
        c.auto(linuxcnc.AUTO_RUN, 1)
    elif mode == "STEP":
        c.auto(linuxcnc.AUTO_STEP)
    elif mode == "PAUSE":
        if s.interp_state != linuxcnc.INTERP_IDLE:
            c.auto(linuxcnc.AUTO_PAUSE)
    elif mode == "RESUME":
        c.auto(linuxcnc.AUTO_RESUME)
    elif mode == "STOP":
        c.abort()
    else:
        return ("unknown mode", 400)

    return "OK"

@api_bp.route("/setState/<state>")
def do_setstate(state):
    try:
        state = int(state)
    except ValueError:
        return ("bad parameter", 400)
    c.state(state)
    return "OK"

@api_bp.route("/feedrate/<rate>")
def do_feedrate(rate):
    try:
        rate = float(rate)
    except ValueError:
        return ("bad parameter", 400)
    if not math.isfinite(rate):
        return ("bad parameter", 400)
    c.feedrate(rate)
    return "OK"

@api_bp.route("/rapidrate/<rate>")
def do_rapidrate(rate):
    try:
        rate = float(rate)
    except ValueError:
        return ("bad parameter", 400)
    if not math.isfinite(rate):
        return ("bad parameter", 400)
    c.rapidrate(rate)
    return "OK"

@api_bp.route("/speedlerate/<spindle>/<rate>")
def do_spindleChange(spindle, rate):
    try:
        rate = float(rate)
        spindle = int(spindle)
    except ValueError:
        return ("bad parameter", 400)
    if not math.isfinite(rate):
        return ("bad parameter", 400)
    c.spindleoverride(rate, spindle)
    return "OK"

@api_bp.route("/spindle/<int:spindle>/<cmd>")
def do_spindle(spindle, cmd):
    cmd = cmd.upper()
    if cmd not in ("OFF", "FORWARD", "REVERSE"):
        return ("unknown spindle command", 400)   # validate before touching the machine
    s.poll()
    if spindle >= len(s.spindle):
        return ("unknown spindle", 400)
    if s.estop or not s.enabled:
        return "FAILED: machine off"
    if s.interp_state != linuxcnc.INTERP_IDLE:
        return "FAILED: program running"
    c.mode(linuxcnc.MODE_MANUAL)
    c.wait_complete()
    if cmd == "OFF":
        # command.spindle() parses "i|ddi": for SPINDLE_OFF (and INCREASE/DECREASE/CONSTANT)
        # the spindle index is the SECOND positional argument, while FORWARD/REVERSE take
        # (direction, speed_rpm, spindle_index).
        c.spindle(linuxcnc.SPINDLE_OFF, spindle)
    else:
        rpm = abs(float(s.spindle[spindle]["speed"])) or 1.0  # like AXIS: last programmed S, else 1 rpm
        direction = linuxcnc.SPINDLE_FORWARD if cmd == "FORWARD" else linuxcnc.SPINDLE_REVERSE
        c.spindle(direction, rpm, spindle)
    return "OK"

@api_bp.route("/homing/<axis>")
def homing(axis):
    if axis in AXIS_NAMES:
        axis = AXIS_NAMES.index(axis)
    try:
        axis = int(axis)
    except ValueError:
        return ("bad parameter", 400)
    c.mode(linuxcnc.MODE_MANUAL)
    c.teleop_enable(0)
    c.wait_complete()
    c.home(axis)
    return "OK"

@api_bp.route("/mdi/<path:command>")
def mdi(command):
    command = command.strip()
    if not command:
        return "FAILED: empty command"
    reason = mdi_blocker()
    if reason is None:
        c.mode(linuxcnc.MODE_MDI)
        c.wait_complete()
        c.mdi(command)
        hist = [x for x in tempdata["mdi_commands"] if x != command] + [command]
        tempdata["mdi_commands"] = hist[-10:]
        return "OK"
    return f"FAILED: {reason}"

@api_bp.route("/update")
def update():

    now = datetime.datetime.now()
    current_time = now.strftime("%H:%M:%S")

    s.poll()

    error = e.poll()
    if error:
        kind, text = error
        if kind in (linuxcnc.NML_ERROR, linuxcnc.OPERATOR_ERROR):
            typus = "error"
        else:
            typus = "info"
        print(tempdata["error_counter"], typus, text)
        tempdata["errors"][tempdata["error_counter"]] = {"time": current_time, "type": typus, "text": text}
        tempdata["error_counter"] += 1
        for key in sorted(tempdata["errors"])[:-100]:
            del tempdata["errors"][key]

    data = {
        "file": s.file,
        "estop": s.estop,
        "enabled": s.enabled,
        "line_num": s.motion_line,
        "interp_state": s.interp_state,
        "task_state": s.task_state,
        "feedrate": s.feedrate,
        "rapidrate": s.rapidrate,
        "axisNames": AXIS_NAMES,
        "position": {},
        "spindle": {},
        "tool_in_spindle": s.tool_in_spindle,
        "current_vel": f"{s.current_vel * 60:08.2f}",
        "din": s.din,
        "dout": s.dout,
        "ain": s.ain,
        "aout": s.aout,
        "paused": s.paused,
        "errors": tempdata["errors"],
        "mdi_commands": tempdata["mdi_commands"],
    }
    for n, pos in enumerate(s.position[:3]):
        data["position"][AXIS_NAMES[n]] = {"homed_str": "homed" if s.homed[n] else "not-homed", "homed": s.homed[n], "pos": f"{pos:0.3f}"}

    for n, spindle in enumerate(s.spindle[:2]):
        data["spindle"][n] = spindle



    #print(data)
    return data
