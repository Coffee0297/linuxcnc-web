"""Phone MPG pendant for LinuxCNC.

    flask run --host=0.0.0.0     # on the machine PC; LinuxCNC may be started before or after
    python app.py                # the same; on Windows/macOS the built-in simulator starts by itself

Open http://<pc-ip>:5000/ on the phone: it lands on the pendant at /mpg/.
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
