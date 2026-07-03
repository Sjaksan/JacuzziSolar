const { createOutputPin, getGpioStatus } = require('./src/gpio');
const { HistoryStore } = require('./src/historyStore');
const { HeaterSensor } = require('./src/heaterSensor');
const axios = require('axios');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Configureer GPIO 17 als uitgang (output)
const gpioStatus = getGpioStatus();
if (!gpioStatus.enabled) {
    console.warn(`GPIO niet beschikbaar (${gpioStatus.reason}). Draaiend in veilige mock-modus.`);
}
const jacuzziRelais = createOutputPin(17, 1);

const EXPORT_THRESHOLD = -200; // Start met opwarmen bij >200 Watt teruglevering (negatief in P1)
const IMPORT_THRESHOLD = 200;   // Stop met extra opwarmen als we stroom gaan inkopen
const CHECK_INTERVAL = 60000;   // Check elke 60 seconden (60000 ms)
const WEB_PORT = Number(process.env.WEB_PORT || 3000);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const UI_PATH = path.join(__dirname, 'public', 'index.html');
const historyStore = new HistoryStore();

const DEFAULT_CONFIG = {
    p1Ip: process.env.P1_IP || '192.168.1.171',
    heaterSensorEnabled: process.env.HEATER_SENSOR_ENABLED === '1',
    heaterCurrentThresholdA: Number(process.env.HEATER_CURRENT_THRESHOLD_A || 1),
    lineVoltageV: Number(process.env.LINE_VOLTAGE_V || 230),
    ads1115I2cBus: Number(process.env.ADS1115_I2C_BUS || 1),
    ads1115Address: Number(process.env.ADS1115_ADDRESS || 0x48),
    ads1115Channel: Number(process.env.ADS1115_CHANNEL || 0),
    sctMilliVoltsPerAmp: Number(process.env.SCT_MV_PER_AMP || 10),
};

const runtimeState = {
    activePowerW: null,
    relayEnabled: true,
    lastCheckAt: null,
    lastError: null,
    heaterCurrentA: null,
    heaterPowerW: null,
    heaterOn: null,
    heaterSensorAvailable: false,
    heaterSensorReason: 'Niet geinitialiseerd.',
};

function isValidIpAddress(ip) {
    const parts = String(ip || '').trim().split('.');
    if (parts.length !== 4) {
        return false;
    }

    return parts.every((part) => {
        if (!/^\d+$/.test(part)) {
            return false;
        }

        const number = Number(part);
        return number >= 0 && number <= 255;
    });
}

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
            return { ...DEFAULT_CONFIG };
        }

        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_CONFIG,
            ...parsed,
        };
    } catch (error) {
        console.error('Kon config niet laden, val terug op defaults:', error.message);
        return { ...DEFAULT_CONFIG };
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();
const heaterSensor = new HeaterSensor({
    enabled: config.heaterSensorEnabled,
    i2cBusNumber: config.ads1115I2cBus,
    address: config.ads1115Address,
    channel: config.ads1115Channel,
    mvPerAmp: config.sctMilliVoltsPerAmp,
    lineVoltage: config.lineVoltageV,
    heaterOnThresholdA: config.heaterCurrentThresholdA,
});

async function logMeasurement(source, errorMessage = null) {
    const power = runtimeState.activePowerW;
    const feedInW = typeof power === 'number' && power < 0 ? Math.abs(power) : 0;

    try {
        await historyStore.insertMeasurement({
            ts: new Date().toISOString(),
            activePowerW: power,
            feedInW,
            relayEnabled: runtimeState.relayEnabled,
            heaterCurrentA: runtimeState.heaterCurrentA,
            heaterPowerW: runtimeState.heaterPowerW,
            heaterOn: Boolean(runtimeState.heaterOn),
            source,
            errorMessage,
        });
    } catch (error) {
        console.error('Kon meting niet opslaan:', error.message);
    }
}

async function setRelayState(enableRelay, reason) {
    const nextState = Boolean(enableRelay);
    const changed = runtimeState.relayEnabled !== nextState;
    runtimeState.relayEnabled = nextState;
    jacuzziRelais.writeSync(nextState ? 1 : 0);
    console.log(reason);

    if (!changed) {
        return;
    }

    try {
        await historyStore.insertRelayEvent({
            ts: new Date().toISOString(),
            relayEnabled: nextState,
            reason,
            activePowerW: runtimeState.activePowerW,
            heaterCurrentA: runtimeState.heaterCurrentA,
            heaterPowerW: runtimeState.heaterPowerW,
            heaterOn: Boolean(runtimeState.heaterOn),
        });
    } catch (error) {
        console.error('Kon relais-event niet opslaan:', error.message);
    }
}

async function updateHeaterTelemetry() {
    const sensorReading = await heaterSensor.read();
    runtimeState.heaterSensorAvailable = Boolean(sensorReading.available);
    runtimeState.heaterSensorReason = sensorReading.reason;
    runtimeState.heaterCurrentA = sensorReading.currentA;
    runtimeState.heaterPowerW = sensorReading.powerW;
    runtimeState.heaterOn = sensorReading.heaterOn;
}

async function checkSolarSurplus() {
    await updateHeaterTelemetry();

    try {
        // 1. Lees de HomeWizard P1 meter uit
        const response = await axios.get(`http://${config.p1Ip}/api/v1/data`, { timeout: 5000 });
        const activePower = response.data.active_power_w;
        runtimeState.activePowerW = activePower;
        runtimeState.lastCheckAt = new Date().toISOString();
        runtimeState.lastError = null;
        
        console.log(`[${new Date().toLocaleTimeString()}] Huidig vermogen: ${activePower}W`);

        // 2. Logica voor het relais
        if (activePower <= EXPORT_THRESHOLD) {
            // Veel zon! Relais UIT = Jacuzzi ziet echte temp en warmt door naar 40°C
            await setRelayState(false, 'Zon schijnt! Jacuzzi mag extra opwarmen. Relais UIT.');
        } 
        else if (activePower >= IMPORT_THRESHOLD) {
            // Geen zon / hoog verbruik in huis. Relais AAN = Jacuzzi foppen (stopt bij 38°C)
            await setRelayState(true, 'Te weinig zon. Jacuzzi begrenzen. Relais AAN.');
        }

        await logMeasurement('p1');

    } catch (error) {
        runtimeState.activePowerW = null;
        runtimeState.lastCheckAt = new Date().toISOString();
        runtimeState.lastError = error.message;
        console.error("Fout bij het uitlezen van de P1 meter:", error.message);
        // Veiligheidsmaatregel: bij fouten, zet het relais AAN zodat de jacuzzi niet onnodig stroom vreet
        await setRelayState(true, 'Veiligheidsmodus actief. Relais AAN.');
        await logMeasurement('p1_error', error.message);
    }
}

function buildHistorySummary(points) {
    let heaterOnMinutes = 0;
    let heaterEnergyWh = 0;

    for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        if (!point.heaterOn || typeof point.heaterPowerW !== 'number') {
            continue;
        }

        const currentTs = Date.parse(point.ts);
        const nextTs = points[index + 1] ? Date.parse(points[index + 1].ts) : (currentTs + CHECK_INTERVAL);
        const deltaMsRaw = nextTs - currentTs;
        const deltaMs = Math.max(15_000, Math.min(10 * 60_000, deltaMsRaw));
        const deltaHours = deltaMs / 3_600_000;

        heaterOnMinutes += deltaMs / 60_000;
        heaterEnergyWh += point.heaterPowerW * deltaHours;
    }

    return {
        points: points.length,
        heaterOnMinutes: Number(heaterOnMinutes.toFixed(1)),
        heaterEnergyWh: Number(heaterEnergyWh.toFixed(1)),
    };
}

function getStatusPayload() {
    const power = runtimeState.activePowerW;
    const feedInW = typeof power === 'number' && power < 0 ? Math.abs(power) : 0;

    return {
        activePowerW: power,
        feedInW,
        relayEnabled: runtimeState.relayEnabled,
        lastCheckAt: runtimeState.lastCheckAt,
        lastError: runtimeState.lastError,
        heaterCurrentA: runtimeState.heaterCurrentA,
        heaterPowerW: runtimeState.heaterPowerW,
        heaterOn: runtimeState.heaterOn,
        heaterSensorAvailable: runtimeState.heaterSensorAvailable,
        heaterSensorReason: runtimeState.heaterSensorReason,
        p1Ip: config.p1Ip,
        gpioEnabled: gpioStatus.enabled,
    };
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 10_000) {
                reject(new Error('Request body te groot.'));
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
            sendJson(res, 200, getStatusPayload());
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/settings') {
            sendJson(res, 200, {
                p1Ip: config.p1Ip,
                heaterSensorEnabled: config.heaterSensorEnabled,
                heaterCurrentThresholdA: config.heaterCurrentThresholdA,
                lineVoltageV: config.lineVoltageV,
                ads1115I2cBus: config.ads1115I2cBus,
                ads1115Address: config.ads1115Address,
                ads1115Channel: config.ads1115Channel,
            });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/history') {
            const hours = Number(requestUrl.searchParams.get('hours') || 24);
            const points = await historyStore.getHistory(hours);
            const relayEvents = await historyStore.getRelayEvents(hours);

            sendJson(res, 200, {
                summary: buildHistorySummary(points),
                points,
                relayEvents,
            });
            return;
        }

        if (req.method === 'PUT' && requestUrl.pathname === '/api/settings') {
            const rawBody = await readRequestBody(req);
            const payload = JSON.parse(rawBody || '{}');
            const nextIp = String(payload.p1Ip || '').trim();

            if (!isValidIpAddress(nextIp)) {
                sendJson(res, 400, { error: 'Ongeldig IP-adres.' });
                return;
            }

            config = {
                ...config,
                p1Ip: nextIp,
            };

            saveConfig(config);
            await checkSolarSurplus();
            sendJson(res, 200, { ok: true, p1Ip: config.p1Ip });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/') {
            fs.readFile(UI_PATH, (error, content) => {
                if (error) {
                    sendJson(res, 500, { error: 'Dashboard kon niet worden geladen.' });
                    return;
                }

                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                res.end(content);
            });
            return;
        }

        sendJson(res, 404, { error: 'Niet gevonden.' });
    } catch (error) {
        sendJson(res, 500, { error: `Serverfout: ${error.message}` });
    }
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`Webpoort ${WEB_PORT} is al in gebruik. Stop de andere instance of zet WEB_PORT.`);
    } else {
        console.error('Webserver fout:', error.message);
    }
    process.exit(1);
});

async function startApp() {
    await historyStore.init();
    await heaterSensor.init();

    runtimeState.heaterSensorAvailable = heaterSensor.available;
    runtimeState.heaterSensorReason = heaterSensor.reason;

    console.log("Jacuzzi Solar Optimizer gestart...");
    if (runtimeState.heaterSensorAvailable) {
        console.log('Heater sensor actief via ADS1115/SCT-013.');
    } else {
        console.log(`Heater sensor inactief: ${runtimeState.heaterSensorReason}`);
    }

    await checkSolarSurplus();
    setInterval(() => {
        checkSolarSurplus().catch((error) => {
            console.error('Onverwachte fout in meetloop:', error.message);
        });
    }, CHECK_INTERVAL);

    server.listen(WEB_PORT, '0.0.0.0', () => {
        console.log(`Web UI beschikbaar op http://0.0.0.0:${WEB_PORT}`);
    });
}

startApp().catch((error) => {
    console.error('Startup mislukt:', error.message);
    process.exit(1);
});

// Netjes afsluiten als het script stopt
process.on('SIGINT', () => {
    jacuzziRelais.unexport();
    heaterSensor.close();
    historyStore.close();
    server.close();
    process.exit();
});