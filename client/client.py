import math
import re
import os
import html
import subprocess
import datetime
import linuxcnc

from flask import Blueprint, render_template, request, redirect
from werkzeug.utils import secure_filename


COMMAND = re.compile(r"(?P<line>\d+) N[\d.]*\s*(?P<type>[A-Z_]+)\((?P<coords>.*)\)")
ALLOWED_EXTENSIONS = {'ngc', 'nc'}
UPLOAD_FOLDER = f"{os.path.expanduser('~')}/nc_files/"

# http://linuxcnc.org/docs/master/html/de/config/python-interface.html

s = linuxcnc.stat()
c = linuxcnc.command()

client_bp = Blueprint(
    "client_bp",
    __name__,  # 'Client Blueprint'
    template_folder="templates",  # Required for our purposes
    static_folder="static",  # Again, this is required
    static_url_path="/client/static",  # Flask will be confused if you don't do this
)


def allowed_file(name):
    return '.' in name and name.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


@client_bp.route("/files")
def files():
    files = {}
    if os.path.isdir(UPLOAD_FOLDER):
        for name in sorted(os.listdir(UPLOAD_FOLDER)):
            if not allowed_file(name):
                continue
            filename = os.path.join(UPLOAD_FOLDER, name)
            if not os.path.isfile(filename):
                continue
            file_stats = os.stat(filename)

            mtime = datetime.datetime.fromtimestamp(file_stats.st_mtime).strftime('%Y-%m-%d %H:%M')

            files[filename] = {"name": name, "size": file_stats.st_size, "mtime": mtime}
    return render_template("files.html", files=files)


@client_bp.route('/upload', methods=['GET', 'POST'])
def upload():
    if request.method == 'POST':
        filefd = request.files.get('file')
        if not filefd or not filefd.filename:
            return 'No file uploaded', 400
        name = secure_filename(filefd.filename)
        if not allowed_file(name):
            return 'Only .ngc/.nc files are accepted', 400
        os.makedirs(UPLOAD_FOLDER, exist_ok=True)
        target = os.path.join(UPLOAD_FOLDER, name)
        # write to a temp file first: a program may be running from the old file
        tmp = target + '.part'
        try:
            filefd.save(tmp)
            os.replace(tmp, target)
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        return redirect("/files")
    return 'No file uploaded'



@client_bp.route("/")
def index():
    filename = request.args.get("filename")
    if filename:
        real = os.path.realpath(filename)
        base = os.path.realpath(UPLOAD_FOLDER)
        if not (real == base or real.startswith(base + os.sep)) or not os.path.isfile(real):
            return 'file must be an existing file inside the upload folder', 400

        s.poll()
        if s.task_mode != linuxcnc.MODE_AUTO:
            c.mode(linuxcnc.MODE_AUTO)
        c.program_open(real)

        return redirect("/")


    s.poll()
    filename = s.file
    if filename and os.path.isfile(filename):
        with open(filename, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    else:
        content = ""

    svg_out = []
    output = []
    if filename and os.path.isfile(filename):
        try:
            # rs274 echoes COMMENT() with the raw source bytes: never let a cp1252 "°" 500 the page
            result = subprocess.run(["rs274", "-g", filename], capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=30)
            output = result.stdout.splitlines()
        except (OSError, subprocess.TimeoutExpired):
            output = []
    last_pos = ()
    pos_min_x = float('inf')
    pos_min_y = float('inf')
    pos_max_x = float('-inf')
    pos_max_y = float('-inf')
    for line in output:
        result = COMMAND.match(line.strip())
        if result:
            if result["type"] in {"ARC_FEED", "STRAIGHT_FEED", "STRAIGHT_TRAVERSE"}:
                coords = result["coords"].split(",")
                new_x = float(coords[0].strip())
                new_y = float(coords[1].strip())
                pos_min_x = min(new_x, pos_min_x)
                pos_min_y = min(new_y, pos_min_y)
                pos_max_x = max(new_x, pos_max_x)
                pos_max_y = max(new_y, pos_max_y)

    if pos_min_x > pos_max_x:
        # no motion in the program
        pos_min_x = pos_min_y = pos_max_x = pos_max_y = 0.0

    width = pos_max_x - pos_min_x
    height = pos_max_y - pos_min_y

    border = max(height / 4, 2.0)

    width += (border * 2)
    height += (border * 2)


    color = "white"
    for line in output:
        result = COMMAND.match(line.strip())
        if result:
            if result["type"] in {"ARC_FEED"}:
                coords = result["coords"].split(",")
                new_x = float(coords[0].strip()) - pos_min_x + border
                new_y = height - (float(coords[1].strip()) - pos_min_y) - border
                new_z = float(coords[5].strip())
                color = "white"
                if coords[4].strip()[0] == "-":
                    direction = "cw"
                else:
                    direction = "ccw"
                radius = round(math.dist((float(coords[0].strip()), float(coords[1].strip())), (float(coords[2].strip()), float(coords[3].strip()))), 4)
                if last_pos:
                    last_x, last_y, last_z = last_pos
                    if direction == "cw":
                        svg_out.append(f'<g stroke="red" fill="none" style="stroke:{color};stroke-width:0.1"><path d="M {last_x} {last_y} A {radius} {radius} 0 0 1 {new_x} {new_y}" /></g>')
                    else:
                        svg_out.append(f'<g stroke="red" fill="none" style="stroke:{color};stroke-width:0.1"><path d="M {new_x} {new_y} A {radius} {radius} 0 0 1 {last_x} {last_y}" /></g>')
                last_pos = (new_x, new_y, new_z)
            elif result["type"] in {"STRAIGHT_FEED", "STRAIGHT_TRAVERSE"}:
                coords = result["coords"].split(",")
                new_x = float(coords[0].strip()) - pos_min_x + border
                new_y = height - (float(coords[1].strip()) - pos_min_y) - border
                new_z = float(coords[2].strip())
                color = "white"
                if result["type"] == "STRAIGHT_TRAVERSE":
                    color = "green"
                if last_pos:
                    last_x, last_y, last_z = last_pos
                    svg_out.append(f'<line x1="{last_x}" y1="{last_y}" x2="{new_x}" y2="{new_y}" style="stroke:{color};stroke-width:0.1" />')
                last_pos = (new_x, new_y, new_z)

    lines = "".join(svg_out)
    svg_str = f'<svg height="100%" width="100%" viewBox="0 0 {width} {height}" style="background-color:black" xmlns="http://www.w3.org/2000/svg">{lines}<circle id="position" cx="0" cy="0" r="1" _border="{border}" _height="{height}" _minx="{pos_min_x}" _miny="{pos_min_y}" style="fill:red;stroke:red;stroke-width:0"/></svg>'

    content_ln = []
    for ln, line in enumerate(content.split("\n"), 1):
        content_ln.append(f"<div id='ln{ln}'>{ln:05}: {html.escape(line)}</div>")


    return render_template("index.html", gcode="".join(content_ln), svg_str=svg_str)


@client_bp.route("/get_file")
def get_file():
    s.poll()
    filename = s.file
    if not filename or not os.path.isfile(filename):
        return 'no file loaded', 404
    with open(filename, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return content.replace("\n", "<br/>")
