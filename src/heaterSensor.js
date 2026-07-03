const DEFAULT_OPTIONS = {
  enabled: false,
  i2cBusNumber: 1,
  address: 0x48,
  channel: 0,
  gain: 4096,
  samplesPerSecond: 250,
  mvPerAmp: 10,
  lineVoltage: 230,
  heaterOnThresholdA: 1.0,
};

class HeaterSensor {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.initialized = false;
    this.available = false;
    this.reason = 'Sensor disabled by config.';
    this.reader = null;
    this.ads = null;
  }

  async init() {
    if (!this.options.enabled) {
      this.available = false;
      this.reason = 'Sensor disabled by config.';
      return;
    }

    if (process.platform !== 'linux') {
      this.available = false;
      this.reason = 'ADS1115 sensor is only supported on Linux runtime.';
      return;
    }

    try {
      const Ads1x15 = require('ads1x15');
      this.ads = new Ads1x15(this.options.i2cBusNumber, this.options.address);

      await new Promise((resolve, reject) => {
        this.ads.openBus((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      this.reader = () =>
        new Promise((resolve, reject) => {
          this.ads.readADCSingleEnded(
            this.options.channel,
            this.options.gain,
            this.options.samplesPerSecond,
            (error, data, volts) => {
              if (error) {
                reject(error);
                return;
              }
              resolve({ data, volts });
            }
          );
        });

      this.available = true;
      this.reason = null;
      this.initialized = true;
    } catch (error) {
      this.available = false;
      this.reason = `ADS1115 unavailable: ${error.message}`;
    }
  }

  async read() {
    if (!this.available || !this.reader) {
      return {
        available: false,
        reason: this.reason,
        currentA: null,
        powerW: null,
        heaterOn: null,
        rawVolts: null,
      };
    }

    try {
      const { volts } = await this.reader();
      const millivolts = Math.abs(Number(volts) * 1000);
      const currentA = millivolts / this.options.mvPerAmp;
      const powerW = currentA * this.options.lineVoltage;
      const heaterOn = currentA >= this.options.heaterOnThresholdA;

      return {
        available: true,
        reason: null,
        currentA,
        powerW,
        heaterOn,
        rawVolts: Number(volts),
      };
    } catch (error) {
      return {
        available: false,
        reason: `Sensor read failed: ${error.message}`,
        currentA: null,
        powerW: null,
        heaterOn: null,
        rawVolts: null,
      };
    }
  }

  close() {
    if (this.ads && typeof this.ads.close === 'function') {
      this.ads.close();
    }
  }
}

module.exports = {
  HeaterSensor,
};
