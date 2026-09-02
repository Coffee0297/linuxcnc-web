const apiEndpoint = '/api_v1/';


const vm = new Vue({
    el: '#vm',
    delimiters: ['[[', ']]'],
    data: {

        estop: 0,
        enabled: 0,
        paused: 0,

        line_num: 0,
        line_num_last: 0,

        interp_state: 0,
        task_state: 0,
        feedrate: 100.0,
        rapidrate: 100.0,

        axisNames: [],
        position: {},

        spindle: 0,
        tool_in_spindle: 0,

        current_vel: 0,

        errors: {},
        mdi_commands: [],
        mdi_status: '',

        din: [],
        dout: [],
        ain: [],
        aout: [],
    },
    created: function(){
        this.fetch()
    },

    methods: {
        mdiCommand: async function () {
            const command = document.getElementById("mdi_command").value.trim();
            if (!command) return;
            const gResponse = await fetch(apiEndpoint + 'mdi/' + encodeURIComponent(command));
            this.mdi_status = gResponse.ok ? await gResponse.text() : 'FAILED: HTTP ' + gResponse.status;
            console.log(gResponse);
        },
        doApiCall: async function (name) {
            const gResponse = await fetch(apiEndpoint + name);
            //const gObject = await gResponse.json();
            console.log(gResponse);
        },
        JogStart: async function (axis, speed) {
            const gResponse = await fetch(apiEndpoint + 'JogStart/' + axis + '/' + speed);
            //const gObject = await gResponse.json();
            console.log(gResponse);
        },
        JogStop: async function (axis) {
            const gResponse = await fetch(apiEndpoint + 'JogStop/' + axis);
            //const gObject = await gResponse.json();
            console.log(gResponse);
        },
        spindleCmd: async function (num, cmd) {
            const gResponse = await fetch(apiEndpoint + 'spindle/' + num + '/' + cmd);
            console.log(gResponse);
        },
        setState: async function (state) {
            const gResponse = await fetch(apiEndpoint + 'setState/' + state);
            //const gObject = await gResponse.json();
            console.log(gResponse);
        },
        feedrateChange: async function () {
            const gResponse = await fetch(apiEndpoint + 'feedrate/' + this.feedrate / 100.0);
            //const gObject = await gResponse.json();
            console.log(gResponse);
        },
        rapidrateChange: async function () {
            const gResponse = await fetch(apiEndpoint + 'rapidrate/' + this.rapidrate / 100.0);
            //const gObject = await gResponse.json();
            console.log(gResponse);
        },
        spindleChange: async function () {
            for (const spindle in this.spindle) {
                const gResponse = await fetch(apiEndpoint + 'speedlerate/' + spindle + '/' + this.spindle[spindle]['override'] / 100.0);
                console.log(gResponse);
            }
        },

        fetch: async function() {
            try {
                const gResponse = await fetch(apiEndpoint + 'update');
                const gObject = await gResponse.json();

                this.estop = gObject.estop;
                this.enabled = gObject.enabled;
                this.paused = gObject.paused;

                this.mdi_commands = gObject.mdi_commands;
                this.errors = gObject.errors;
                if (gObject.line_num != this.line_num) {
                    if (this.line_num != 0) {
                        const oldLine = document.getElementById('ln' + this.line_num);
                        if (oldLine) {
                            oldLine.style.color = "black";
                        }
                    }
                    this.line_num = gObject.line_num;
                    if (this.line_num != 0) {
                        const newLine = document.getElementById('ln' + this.line_num);
                        if (newLine) {
                            newLine.style.color = "red";
                        }
                        const scrollLine = document.getElementById('ln' + (this.line_num > 4 ? this.line_num - 4 : this.line_num));
                        if (scrollLine) {
                            scrollLine.scrollIntoView();
                        }
                    }
                }

                this.interp_state = gObject.interp_state;
                this.task_state = gObject.task_state;

                this.feedrate = gObject.feedrate * 100.0;
                this.rapidrate = gObject.rapidrate * 100.0;

                this.axisNames = gObject.axisNames;
                this.position = gObject.position;
                this.spindle = gObject.spindle;

                for (const spindle in this.spindle) {
                    this.spindle[spindle]['override'] = this.spindle[spindle]['override'] * 100.0;
                }
                this.tool_in_spindle = gObject.tool_in_spindle;
                this.current_vel = gObject.current_vel;
                this.din = gObject.din;
                this.dout = gObject.dout;
                this.ain = gObject.ain;
                this.aout = gObject.aout;


                const element = document.getElementById("position");
                if (element && this.position.X && this.position.Y) {
                    const height = parseFloat(element.getAttribute("_height"));
                    const border = parseFloat(element.getAttribute("_border"));
                    // client.py shifts the toolpath by (-minx, -miny); apply the same shift to the marker
                    const minx = parseFloat(element.getAttribute("_minx")) || 0;
                    const miny = parseFloat(element.getAttribute("_miny")) || 0;

                    element.setAttribute("cx", (parseFloat(this.position.X.pos) - minx) + border);
                    element.setAttribute("cy", height - (parseFloat(this.position.Y.pos) - miny) - border);
                }
            } catch (err) {
                console.error(err);
            }

        }
    },
    mounted: function () {
      window.setInterval(() => {
        this.fetch()
      }, 500)
    }


})
