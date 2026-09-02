#!/usr/bin/env python3
"""Run only the MPG pendant, without the rest of linuxcnc-web.

Useful for testing on any PC: the built-in simulator starts automatically on
Windows/macOS; on Linux run it with MPG_SIM=1 (see README):

    python standalone_mpg.py

then open  http://<pc-ip>:5000/mpg/  on the phone (same network).
"""
from flask import Flask, redirect
from mpg.mpg import mpg_bp

app = Flask(__name__)
app.register_blueprint(mpg_bp, url_prefix="/mpg")


@app.route("/")
def root():
    return redirect("/mpg/")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, threaded=True)
