const fs = require('fs');
const path = require('path');

const DEFAULT_OPTIONS = {
  enabled: true,
  basePath: '/sys/bus/w1/devices',
  sensorId: null,
};

class TemperatureSensor {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.available = false;
    this.reason = 'Temperatuursensor uitgeschakeld.';
    this.deviceFile = null;
  }

  async init() {
    if (!this.options.enabled) {
      this.available = false;
      this.reason = 'Temperatuursensor uitgeschakeld.';
      return;
    }

    if (process.platform !== 'linux') {
      this.available = false;
      this.reason = 'Temperatuursensor wordt alleen op Linux ondersteund.';
      return;
    }

    try {
      const basePath = String(this.options.basePath || '').trim() || DEFAULT_OPTIONS.basePath;
      const requestedId = this.options.sensorId ? String(this.options.sensorId).trim() : null;

      let deviceDir = null;
      if (requestedId) {
        const candidate = path.join(basePath, requestedId);
        if (fs.existsSync(candidate)) {
          deviceDir = candidate;
        }
      }

      if (!deviceDir) {
        const entries = fs.readdirSync(basePath, { withFileTypes: true });
        const sensorEntry = entries.find(
          (entry) => entry.isDirectory() && /^(28|10)-[0-9a-f]+$/i.test(entry.name)
        );

        if (sensorEntry) {
          deviceDir = path.join(basePath, sensorEntry.name);
        }
      }

      if (!deviceDir) {
        this.available = false;
        this.reason = 'Geen 1-wire temperatuursensor gevonden.';
        return;
      }

      const sensorFile = path.join(deviceDir, 'w1_slave');
      if (!fs.existsSync(sensorFile)) {
        this.available = false;
        this.reason = 'Sensorbestand w1_slave ontbreekt.';
        return;
      }

      this.deviceFile = sensorFile;
      this.available = true;
      this.reason = null;
    } catch (error) {
      this.available = false;
      this.reason = `Temperatuursensor niet beschikbaar: ${error.message}`;
    }
  }

  async read() {
    if (!this.available || !this.deviceFile) {
      return {
        available: false,
        reason: this.reason,
        temperatureC: null,
      };
    }

    try {
      const raw = fs.readFileSync(this.deviceFile, 'utf8');
      const lines = raw.trim().split(/\r?\n/);

      if (lines.length < 2 || !lines[0].includes('YES')) {
        return {
          available: false,
          reason: 'Sensor CRC check mislukt.',
          temperatureC: null,
        };
      }

      const match = lines[1].match(/t=(-?\d+)/);
      if (!match) {
        return {
          available: false,
          reason: 'Kon temperatuurwaarde niet parsen.',
          temperatureC: null,
        };
      }

      const milliCelsius = Number(match[1]);
      const temperatureC = milliCelsius / 1000;

      return {
        available: true,
        reason: null,
        temperatureC,
      };
    } catch (error) {
      return {
        available: false,
        reason: `Sensor read failed: ${error.message}`,
        temperatureC: null,
      };
    }
  }
}

module.exports = {
  TemperatureSensor,
};