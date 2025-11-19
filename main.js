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
const { HttpsCookieAgent } = require("http-cookie-agent/http");

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
      httpsAgent: new HttpsCookieAgent({ cookies: { jar: this.cookieJar } }),
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
    let loginHtml = await this.requestClient({
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
    loginHtml = await this.requestClient({
      method: "post",
      url:
        "https://account.withings.com/new_workflow/login?r=https://account.withings.com/oauth2_user/account_login?response_type=code&client_id=" +
        this.config.clientid +
        "&state=h4fhjnc2daoc3m&scope=user.activity%2Cuser.metrics%2Cuser.info&redirect_uri=http%3A%2F%2Flocalhost&b=authorize2",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "Accept-Language": "de",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      jar: this.cookieJar,
      withCredentials: true,
      data: qs.stringify(form),
    })
      .then(async (res) => {
        return res.data;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        return;
      });

    form = this.extractHidden(loginHtml);
    form.password = this.config.password;

    const resultArray = await this.requestClient({
      method: "post",
      url:
        "https://account.withings.com/new_workflow/password_check?r=https%3A%2F%2Faccount.withings.com%2Foauth2_user%2Faccount_login%3Fresponse_type%3Dcode%26client_id%3D" +
        this.config.clientid +
        "%26state%3Dh4fhjnc2daoc3m%26scope%3Duser.activity%252Cuser.metrics%252Cuser.info%26redirect_uri%3Dhttp%253A%252F%252Flocalhost%26b%3Dauthorize2",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
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
            //eslint-disable-next-line no-useless-escape
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
                Accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
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
                return;
              });
          }
          return responseArray;
        } else {
          return [res];
        }
      })
      .catch((error) => {
        if (error.response && error.response.status === 302) {
          return [];
        }
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        return [];
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
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
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

  /**
   * Schreibe pro Measure-Type den letzten (neuesten) Messwert als State unter userid.lastMeasures.<type>
   * measuregrps wird idealerweise sortiert übergeben (neueste zuerst), aber wir schützen uns trotzdem.
   */
async writeLastMeasures(userid, measuregrps, descriptions) {
    if (!Array.isArray(measuregrps) || measuregrps.length === 0) return;

    await this.setObjectNotExistsAsync(`${userid}.lastMeasures`, {
        type: "channel",
        common: { name: "Letzte Messwerte" },
        native: {},
    });

    const seen = new Set();

    for (const grp of measuregrps) {
        if (!grp?.measures) continue;

        //const tsRaw = Number(grp.date) || null; // Sekunden
		const tsRaw = typeof grp.date === "number" ? grp.date * 1000 : null; // Millisekunden

        for (const m of grp.measures) {
            const t = m.type;
            if (seen.has(t)) continue;

            const val = m.value * Math.pow(10, m.unit);
            const base = `${userid}.lastMeasures.${t}`;
            const raw = `${userid}.lastMeasures.${t}_timestamp`;

            // --- Wert ---
            await this.setObjectNotExistsAsync(base, {
                type: "state",
                common: {
                    name: descriptions?.[t] || `Measure ${t}`,
                    type: "number",
                    role: "value",
                    read: true,
                    write: false,
                },
                native: { type: t, unit: m.unit },
            });
            await this.setStateAsync(base, { val: val, ack: true });

            // --- Raw Timestamp ---
            await this.setObjectNotExistsAsync(raw, {
                type: "state",
                common: {
                    name: `Timestamp Measure ${t}`,
                    type: "number",
                    role: "date", // <-- hier geändert
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync(raw, { val: tsRaw, ack: true });

            seen.add(t);
        }
    }
}
  /**
   * Schreibe die letzte Aktivität als States unter userid.lastActivity.<key>
   * data ist die body-Antwort mit data.activities (Array)
   */
	async writeLastActivity(userid, data) {
		try {
			if (!data || !Array.isArray(data.activities) || data.activities.length === 0) return;

			// Neueste Aktivität
			const activity = data.activities[0];
			if (!activity) return;

			await this.setObjectNotExistsAsync(`${userid}.lastActivity`, {
				type: "channel",
				common: { name: "Letzte Aktivität" },
				native: {},
			});

			// Felder, die eindeutig Zeitstempel darstellen
			const isDateField = (key) =>
				/(date|startdate|enddate|timestamp|modified|created)$/i.test(key);

			for (const key of Object.keys(activity)) {
				const rawValue = activity[key];
				const stateId = `${userid}.lastActivity.${key}`;
				
				const determineType = (value) => {
					if (typeof value === "number") return "number";
					if (typeof value === "boolean") return "boolean";
					return "string"; // fallback für alles andere
				};

				const common = {
					name: `Letzte Aktivität - ${key}`,
					type: determineType(rawValue),
					role: isDateField(key) ? "date" : "value",
					read: true,
					write: false,
				};

				await this.setObjectNotExistsAsync(stateId, {
					type: "state",
					common,
					native: {},
				});

				const outValue =
					typeof rawValue === "object" ? JSON.stringify(rawValue) : rawValue;

				await this.setStateAsync(stateId, { val: outValue, ack: true });
			}

		} catch (e) {
			this.log.error("writeLastActivity failed: " + e);
		}
	}
  /**
   * Schreibe die letzte Sleep Summary als States unter userid.lastSleep.<key>
   * data ist die body-Antwort, erwartet data.series (Array)
   * Konvertiert: created, startdate, enddate, modified -> ISO
   */
async writeLastSleepSummary(userid, data) {
    try {
        if (!data || !Array.isArray(data.series) || data.series.length === 0) return;

        const series = data.series[0] || data.series[data.series.length - 1];
        if (!series) return;

        await this.setObjectNotExistsAsync(`${userid}.lastSleep`, {
            type: "channel",
            common: { name: "Letzte Sleep Summary" },
            native: {},
        });

        const isDateField = (key) =>
            /(date|startdate|enddate|modified|created)$/i.test(key);

        // --- Obere Ebene ---
        for (const key of Object.keys(series)) {
            if (key === "data") continue;

            const rawValue = series[key];
            const stateId = `${userid}.lastSleep.${key}`;

			const determineType = (value) => {
				if (typeof value === "number") return "number";
				if (typeof value === "boolean") return "boolean";
				return "string"; // fallback für alles andere
			};

            const common = {
                name: `Letzte Sleep - ${key}`,
                type: determineType(rawValue),
                role: isDateField(key) ? "date" : "value",
                read: true,
                write: false,
            };

            await this.setObjectNotExistsAsync(stateId, {
                type: "state",
                common,
                native: {},
            });

            const outValue =
                typeof rawValue === "object" ? JSON.stringify(rawValue) : rawValue;

            await this.setStateAsync(stateId, { val: outValue, ack: true });
        }

        // --- data-Objekt ---
        if (series.data && typeof series.data === "object") {
            for (const key of Object.keys(series.data)) {
                const rawValue = series.data[key];
                const stateId = `${userid}.lastSleep.${key}`;

				const determineType = (value) => {
					if (typeof value === "number") return "number";
					if (typeof value === "boolean") return "boolean";
					return "string"; // fallback für alles andere
				};

                const common = {
                    name: `Letzte Sleep - ${key}`,
                    type: determineType(rawValue),
                    role: isDateField(key) ? "date" : "value",
                    read: true,
                    write: false,
                };

                await this.setObjectNotExistsAsync(stateId, {
                    type: "state",
                    common,
                    native: {},
                });

                const outValue =
                    typeof rawValue === "object" ? JSON.stringify(rawValue) : rawValue;

                await this.setStateAsync(stateId, { val: outValue, ack: true });
            }
        }
    } catch (e) {
        this.log.error("writeLastSleepSummary failed: " + e);
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
            meastypes: "1,4,5,6,8,9,10,11,12,54,71,73,76,77,88,91,123,135,136,137,138,139,170",

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
            data_fields:
              "steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3",
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
              "breathing_disturbances_intensity,deepsleepduration,durationtosleep,durationtowakeup,hr_average,hr_max,hr_min,lightsleepduration,remsleepduration,rr_average,rr_max,rr_min,sleep_score,snoring,snoringepisodecount,wakeupcount,wakeupduration,nb_rem_episodes,sleep_efficiency,sleep_latency,total_sleep_time,total_timeinbed,wakeup_latency,waso,apnea_hypopnea_index,asleepduration,night_events,out_of_bed_count",
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
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            const data = res.data.body;
            if (Array.isArray(data?.measuregrps)) {
              data.measuregrps.sort((a, b) => {
                const numeric = (obj, key) => {
                  const value = obj && obj[key];
                  return typeof value === "number" ? value : Number(value) || 0;
                };
                const compareChain = ["date", "created", "modified", "grpid"];
                for (const field of compareChain) {
                  const diff = numeric(b, field) - numeric(a, field);
                  if (diff !== 0) {
                    return diff;
                  }
                }
                return 0;
              });
            }
            if (data.activities) {
              // sort activities by modified timestamp (newest first)
              data.activities.sort((a, b) => (b.modified || 0) - (a.modified || 0));
            }
            if (element.path === "sleepSummary" || element.path === "sleep") {
              if (data.series && data.series.sort) {
                data.series.sort((a, b) => b.startdate - a.startdate);
              }
            }
            if (element.path === "sleep" && data.series) {
              data.series.map((element) => {
                for (const key in element) {
                  if (typeof element[key] === "object") {
                    const newArray = [];
                    for (const timestamp in element[key]) {
                      newArray.push({ timestamp: timestamp, value: element[key][timestamp] });
                    }
                    newArray.sort((a, b) => b.timestamp - a.timestamp);
                    element[key] = newArray;
                  }
                }
              });
            }
            // if (data.measuregrps) {
            //     data.measuregrps.sort((a, b) => a.date - b.date);
            // }
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
              170: "Visceral Fat (without unity)",
            };
  
            // === NEU: Schreibe die letzten Messwerte pro Type in userid.lastMeasures.<type>
            if (element.path === "measures" && Array.isArray(data?.measuregrps)) {
              try {
                await this.writeLastMeasures(userid, data.measuregrps, descriptions);
              } catch (e) {
                this.log.error("writeLastMeasures failed: " + e);
              }
            }
            // === NEU: Schreibe die letzte Activity in userid.lastActivity.<key>
            if (element.path === "activity" && data) {
              try {
                await this.writeLastActivity(userid, data);
              } catch (e) {
                this.log.error("writeLastActivity failed: " + e);
              }
            }
            // === NEU: Schreibe die letzte Sleep Summary in userid.lastSleep.<key>
            if (element.path === "sleepSummary" && data) {
              try {
                await this.writeLastSleepSummary(userid, data);
              } catch (e) {
                this.log.error("writeLastSleepSummary failed: " + e);
              }
            }
            // === ENDE NEU

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
    const cleanOldVersion = await this.getObjectAsync("oldVersionCleanedv2");
    if (!cleanOldVersion) {
      this.log.info("Please wait a few minutes.... clean old version");
      await this.delForeignObjectAsync(this.name + "." + this.instance, { recursive: true });
      await this.setObjectNotExistsAsync("oldVersionCleanedv2", {
        type: "state",
        common: {
          type: "boolean",
          role: "boolean",
          write: false,
          read: true,
        },
        native: {},
      });

      this.log.info("Done with cleaning, restart adapter");
      this.restart();
    }
  }
  extractHidden(body) {
    const returnObject = {};
    if (!body) {
      this.log.warn("No body found");
    }
    let matches;
    if (body.matchAll) {
      matches = body.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g);
    } else {
      this.log.warn(
        "The adapter needs in the future NodeJS v12. https://forum.iobroker.net/topic/22867/how-to-node-js-f%C3%BCr-iobroker-richtig-updaten",
      );
      matches = this.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g, body);
    }
    for (const match of matches) {
      returnObject[match[1]] = match[2];
    }
    return returnObject;
  }
  matchAll(re, str) {
    let match;
    const matches = [];

    while ((match = re.exec(str))) {
      // add all matched groups
      matches.push(match);
    }

    return matches;
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
      this.log.error(e);
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
        // const deviceId = id.split(".")[2];
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
