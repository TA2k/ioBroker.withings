"use strict";

/*
 * Created with @iobroker/create-adapter v2.0.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const qs = require("qs");
const Json2iob = require("./lib/json2iob");
const tough = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent");

class Withings extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "withings",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.deviceArray = [];
        this.json2iob = new Json2iob(this);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        if (!this.config.lastDays || this.config.lastDays < 1) {
            this.config.lastDays = 1;
        }
        if (!this.config.lastHours || this.config.lastHours < 1) {
            this.config.lastHours = 1;
        }
        if (!this.config.username || !this.config.password || !this.config.clientid || !this.config.clientsecret) {
            this.log.error("Please set username and password in the instance settings");
            return;
        }
        this.userAgent = "ioBroker v0.0.1";
        this.cookieJar = new tough.CookieJar();
        this.requestClient = axios.create({
            jar: this.cookieJar,
            withCredentials: true,
            httpsAgent: new HttpsCookieAgent({
                jar: this.cookieJar,
            }),
        });

        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.session = [];
        await this.cleanOldVersion();
        this.subscribeStates("*");

        await this.login();

        if (this.session.length > 0) {
            await this.getDeviceList();
            await this.updateDevices();
            this.updateInterval = setInterval(async () => {
                await this.updateDevices();
            }, this.config.interval * 60 * 1000);
            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, this.session[0].expires_in * 1000);
        }
    }
    async login() {
        const loginHtml = await this.requestClient({
            method: "get",
            url:
                "https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=" +
                this.config.clientid +
                "&state=h4fhjnc2daoc3m&scope=user.activity,user.metrics,user.info&redirect_uri=http://localhost",
            headers: {
                Accept: "*/*",
                "User-Agent": this.userAgent,
            },
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.log.debug(res.request.path);
                return res.data;
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        let form = this.extractHidden(loginHtml);
        form.email = this.config.username;
        form.password = this.config.password;

        const resultArray = await this.requestClient({
            method: "post",
            url:
                "https://account.withings.com/oauth2_user/account_login?response_type=code&client_id=" +
                this.config.clientid +
                "&state=h4fhjnc2daoc3m&scope=user.activity,user.metrics,user.info&redirect_uri=http://localhost&b=authorize2",
            headers: {
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                "Accept-Language": "de",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            jar: this.cookieJar,
            withCredentials: true,
            data: qs.stringify(form),
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (res.data.errors) {
                    this.log.error(JSON.stringify(res.data));
                    return;
                }
                if (res.data.indexOf("user_selection") !== -1) {
                    let urlArray = res.data.split("response_type=code");
                    urlArray.shift();
                    urlArray = urlArray.map((url) => {
                        return url.split('"')[0].replace(/\&amp;/g, "&");
                    });
                    let nameArray = res.data.split("selecteduser=");
                    nameArray.shift();
                    nameArray = nameArray = nameArray.map((name) => {
                        const key = name.split('"')[0];
                        const value = name.split('group-item">')[1].split("<")[0];
                        return { id: key, name: value };
                    });
                    for (const element of nameArray) {
                        await this.setObjectNotExistsAsync(element.id, {
                            type: "device",
                            common: {
                                name: element.name,
                            },
                            native: {},
                        });
                    }
                    const responseArray = [];
                    for (const url of urlArray) {
                        await this.requestClient({
                            method: "get",
                            url: "https://account.withings.com/oauth2_user/account_login?response_type=code" + url,
                            headers: {
                                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                                "Accept-Language": "de",
                            },
                            jar: this.cookieJar,
                            withCredentials: true,
                        })
                            .then((res) => {
                                this.log.debug(JSON.stringify(res.data));
                                this.log.debug(res.request.path);
                                responseArray.push(res);
                                return;
                            })
                            .catch((error) => {
                                this.log.error(error);
                                if (error.response) {
                                    this.log.error(JSON.stringify(error.response.data));
                                }
                            });
                    }
                    return responseArray;
                } else {
                    return [res];
                }
            })
            .catch((error) => {
                if (error.response && error.response.status === 302) {
                    return;
                }
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });

        for (const result of resultArray) {
            if (!result) {
                return;
            }
            form = this.extractHidden(result.data);
            form.authorized = "1";
            const code = await this.requestClient({
                method: "post",
                url: "https://account.withings.com" + result.request.path,
                headers: {
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                    "Accept-Language": "de",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                jar: this.cookieJar,
                withCredentials: true,
                data: qs.stringify(form),
                maxRedirects: 0,
            })
                .then((res) => {
                    this.log.debug(JSON.stringify(res.data));
                    this.log.debug(res.request.path);
                    this.log.debug(res.headers.location);
                    if (res.headers.location) {
                        return res.headers.location.split("code=")[1];
                    }
                    this.log.warn("Please check username and password");
                    return;
                })
                .catch((error) => {
                    if (error.response && error.response.status === 302) {
                        this.log.debug(JSON.stringify(error.response.headers));
                        if (error.response.headers.location.indexOf("code=") === -1) {
                            this.log.debug(JSON.stringify(error.response.headers));
                            this.log.error("No code found");
                            return null;
                        }
                        return error.response.headers.location.split("code=")[1].split("&")[0];
                    }

                    this.log.error(error);
                    if (error.response) {
                        this.log.error(JSON.stringify(error.response.data));
                    }
                });

            await this.requestClient({
                method: "post",
                url: "https://wbsapi.withings.net/v2/oauth2",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data: qs.stringify({
                    action: "requesttoken",
                    grant_type: "authorization_code",
                    client_id: this.config.clientid,
                    client_secret: this.config.clientsecret,
                    code: code,
                    redirect_uri: "http://localhost",
                }),
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));
                    if (res.data.error) {
                        this.log.error(JSON.stringify(res.data));
                        return;
                    }
                    this.session.push(res.data.body);
                    await this.setObjectNotExistsAsync(res.data.body.userid, {
                        type: "device",
                        common: {
                            name: "Hauptnutzer",
                        },
                        native: {},
                    });
                    this.setState("info.connection", true, true);
                })
                .catch((error) => {
                    this.log.error(error);
                    if (error.response) {
                        this.log.error(JSON.stringify(error.response.data));
                    }
                });
        }
    }
    async getDeviceList() {
        for (const session of this.session) {
            await this.requestClient({
                method: "post",
                url: "https://wbsapi.withings.net/v2/user?action=getdevice",
                headers: {
                    Authorization: "Bearer " + session.access_token,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));
                    if (!res.data.body.devices) {
                        return;
                    }
                    for (const device of res.data.body.devices) {
                        const id = device.deviceid;
                        if (this.deviceArray.indexOf(id) === -1) {
                            this.deviceArray.push(id);
                        }
                        const name = device.model;

                        await this.setObjectNotExistsAsync(id, {
                            type: "device",
                            common: {
                                name: name,
                            },
                            native: {},
                        });
                        await this.setObjectNotExistsAsync(id + ".remote", {
                            type: "channel",
                            common: {
                                name: "Remote Controls",
                            },
                            native: {},
                        });

                        const remoteArray = [{ command: "Refresh", name: "True = Refresh" }];
                        remoteArray.forEach((remote) => {
                            this.setObjectNotExists(id + ".remote." + remote.command, {
                                type: "state",
                                common: {
                                    name: remote.name || "",
                                    type: remote.type || "boolean",
                                    role: remote.role || "boolean",
                                    write: true,
                                    read: true,
                                },
                                native: {},
                            });
                        });
                        this.json2iob.parse(id, device);
                    }
                })
                .catch((error) => {
                    this.log.error(error);
                    error.response && this.log.error(JSON.stringify(error.response.data));
                });
        }
    }

    async updateDevices() {
        for (const session of this.session) {
            const userid = session.userid;
            const date = new Date().toISOString().split("T")[0];
            const startTimestampday = new Date().setDate(new Date().getDate() - this.config.lastDays);
            const startDateFormattedday = new Date(startTimestampday).toISOString().split("T")[0];
            const limitSeconds = this.config.lastDays * 24 * 60 * 60;

            const statusArray = [
                {
                    path: "measures",
                    url: "https://wbsapi.withings.net/measure",
                    desc: "Measurements",
                    data: {
                        action: "getmeas",
                        meastypes: "1,4,5,6,8,9,10,11,12,54,71,73,76,77,88,91,123,135,136,137,138,139",

                        startdate: Math.round(Date.now() / 1000) - limitSeconds,
                        enddate: Math.round(Date.now() / 1000),
                    },
                    forceIndex: false,
                    preferedArrayName: "type",
                },
                {
                    path: "activity",
                    url: "https://wbsapi.withings.net/v2/measure",
                    desc: "Activity",
                    data: {
                        action: "getactivity",

                        startdateymd: startDateFormattedday,
                        enddateymd: date,
                    },
                    forceIndex: true,
                },
                {
                    path: "heartList",
                    url: "https://wbsapi.withings.net/v2/heart",
                    desc: "List of ECG recordings",
                    data: {
                        action: "list",
                        startdate: Math.round(Date.now() / 1000) - limitSeconds,
                        enddate: Math.round(Date.now() / 1000),
                    },
                    forceIndex: true,
                },
                {
                    path: "sleepSummary",
                    url: "https://wbsapi.withings.net/v2/sleep",
                    desc: "Basic information about a night",
                    data: {
                        action: "getsummary",
                        startdateymd: startDateFormattedday,
                        enddateymd: date,
                        data_fields:
                            "breathing_disturbances_intensity,deepsleepduration,durationtosleep,durationtowakeup,hr_average,hr_max,hr_min,lightsleepduration,remsleepduration,rr_average,rr_max,rr_min,sleep_score,snoring,snoringepisodecount,wakeupcount,wakeupduration,nb_rem_episodes,sleep_efficiency,sleep_latency,total_sleep_time,total_timeinbed,wakeup_latency,waso,apnea_hypopnea_index,asleepduration",
                    },
                    forceIndex: true,
                },
                {
                    path: "sleep",
                    url: "https://wbsapi.withings.net/v2/sleep",
                    desc: "Sleep measures for the night ",
                    data: {
                        action: "get",
                        startdate: Math.round(Date.now() / 1000) - this.config.lastHours * 60 * 60,
                        enddate: Math.round(Date.now() / 1000),
                        data_fields: "hr,rr,snoring",
                    },
                    forceIndex: true,
                },
            ];
            const headers = {
                authorization: "Bearer " + session.access_token,
                "user-agent": this.userAgent,
            };
            for (const element of statusArray) {
                await this.requestClient({
                    method: "post",
                    url: element.url,
                    headers: headers,
                    data: qs.stringify(element.data),
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        if (!res.data) {
                            return;
                        }
                        const data = res.data.body;
                        if (data.activities) {
                            data.activities.sort((a, b) => a.date.localeCompare(b.date));
                        }
                        const descriptions = {
                            1: "Weight (kg)",
                            4: "Height (meter)",
                            5: "Fat Free Mass (kg)",
                            6: "Fat Ratio (%)",
                            8: "Fat Mass Weight (kg)",
                            9: "Diastolic Blood Pressure (mmHg)",
                            10: "Systolic Blood Pressure (mmHg)",
                            11: "Heart Pulse (bpm) - only for BPM and scale devices",
                            12: "Temperature (celsius)",
                            54: "SP02 (%)",
                            71: "Body Temperature (celsius)",
                            73: "Skin Temperature (celsius)",
                            76: "Muscle Mass (kg)",
                            77: "Hydration (kg)",
                            88: "Bone Mass (kg)",
                            91: "Pulse Wave Velocity (m/s)",
                            123: "VO2 max is a numerical measurement of your body’s ability to consume oxygen (ml/min/kg).",
                            135: "QRS interval duration based on ECG signal",
                            136: "PR interval duration based on ECG signal",
                            137: "QT interval duration based on ECG signal",
                            138: "Corrected QT interval duration based on ECG signal",
                            139: "Atrial fibrillation result from PPG",
                        };
                        this.json2iob.parse(userid + "." + element.path, data, {
                            forceIndex: element.forceIndex,
                            preferedArrayName: element.preferedArrayName,
                            channelName: element.desc,
                            descriptions: descriptions,
                        });
                    })
                    .catch((error) => {
                        if (error.response) {
                            if (error.response.status === 401) {
                                error.response && this.log.debug(JSON.stringify(error.response.data));
                                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                                this.refreshTokenTimeout = setTimeout(() => {
                                    this.refreshToken();
                                }, 1000 * 60);

                                return;
                            }
                        }
                        this.log.error(element.url);
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                    });
            }
        }
    }
    async refreshToken() {
        if (this.session.length === 0) {
            this.log.error("No session found relogin");
            await this.login();
            return;
        }

        for (const session of this.session) {
            await this.requestClient({
                method: "post",
                url: "https://wbsapi.withings.net/v2/oauth2",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data: qs.stringify({
                    action: "requesttoken",
                    grant_type: "refresh_token",
                    client_id: this.config.clientid,
                    client_secret: this.config.clientsecret,
                    refresh_token: session.refresh_token,
                }),
            })
                .then((res) => {
                    this.log.debug(JSON.stringify(res.data));
                    if (res.data.body && res.data.body.access_token) {
                        const index = this.session.indexOf(session);
                        this.session[index] = res.data.body;
                        this.setState("info.connection", true, true);
                    }
                })
                .catch((error) => {
                    this.log.error("refresh token failed");
                    this.log.error(error);
                    error.response && this.log.error(JSON.stringify(error.response.data));
                    this.log.error("Start relogin in 1min");
                    this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
                    this.reLoginTimeout = setTimeout(() => {
                        this.login();
                    }, 1000 * 60 * 1);
                });
        }
    }
    async cleanOldVersion() {
        const cleanOldVersion = await this.getObjectAsync("oldVersionCleaned");
        if (!cleanOldVersion) {
            this.log.info("Please wait a few minutes.... clean old version");
            await this.delForeignObjectAsync(this.name + "." + this.instance, { recursive: true });
            await this.setObjectNotExistsAsync("oldVersionCleaned", {
                type: "state",
                common: {
                    type: "boolean",
                    role: "boolean",
                    write: false,
                    read: true,
                },
                native: {},
            });

            this.log.info("Done with cleaning");
        }
    }
    extractHidden(body) {
        const returnObject = {};
        let matches;
        if (body.matchAll) {
            matches = body.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g);
        } else {
            this.log.warn("The adapter needs in the future NodeJS v12. https://forum.iobroker.net/topic/22867/how-to-node-js-f%C3%BCr-iobroker-richtig-updaten");
            matches = this.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g, body);
        }
        for (const match of matches) {
            returnObject[match[1]] = match[2];
        }
        return returnObject;
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState("info.connection", false, true);
            this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
            this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
            this.updateInterval && clearInterval(this.updateInterval);
            this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            if (!state.ack) {
                const deviceId = id.split(".")[2];
                const command = id.split(".")[4];
                if (id.split(".")[3] !== "remote") {
                    return;
                }

                if (command === "Refresh") {
                    this.updateDevices();
                }
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Withings(options);
} else {
    // otherwise start the instance directly
    new Withings();
}
