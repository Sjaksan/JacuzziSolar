const fs = require('fs');

const DEFAULT_OPTIONS = {
  enabled: true,
  i2cBusNumber: 1,
  address: 0x48,
  channel: 0,
  differential: true,
  gain: 4096,
  samplesPerSecond: 250,
  mvPerAmp: 10,
  lineVoltage: 230,
  heaterOnThresholdA: 1.0,
  operationTimeoutMs: 2000,
  rmsSampleCount: 32,
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

    const i2cDevicePath = `/dev/i2c-${this.options.i2cBusNumber}`;
    if (!fs.existsSync(i2cDevicePath)) {
      this.available = false;
      this.reason = `I2C device ontbreekt: ${i2cDevicePath}. Zet I2C aan en laad i2c-dev.`;
      return;
    }

    try {
      const Ads1x15 = require('ads1x15');
      this.ads = new Ads1x15(this.options.i2cBusNumber, this.options.address);

      // Support both promise-based and callback-based versions of ads1x15.
      await this.openAdsBus();

      this.reader = this.options.differential
        ? () => this.readDifferential01()
        : () => this.readSingleEnded(this.options.channel);

      this.available = true;
      this.reason = null;
      this.initialized = true;
    } catch (error) {
      this.available = false;
      this.reason = `ADS1115 unavailable: ${error.message}`;
    }
  }

  async readSingleEnded(channel) {
    const volts = await this.ads.readADCSingleEnded(
      channel,
      this.options.gain,
      this.options.samplesPerSecond
    );

    return { data: null, volts };
  }

  async readDifferential01() {
    if (typeof this.ads.readADCDifferential01 === 'function') {
      const millivolts = await this.ads.readADCDifferential01(this.options.gain, this.options.samplesPerSecond);
      return { data: null, millivolts };
    }

    if (typeof this.ads.readADCDifferential === 'function') {
      const millivolts = await this.ads.readADCDifferential(0, 1, this.options.gain, this.options.samplesPerSecond);
      return { data: null, millivolts };
    }

    return new Promise((resolve, reject) => {
      Promise.all([
        this.ads.readADCSingleEnded(0, this.options.gain, this.options.samplesPerSecond),
        this.ads.readADCSingleEnded(1, this.options.gain, this.options.samplesPerSecond),
      ])
        .then(([voltsA0, voltsA1]) => {
          resolve({
            data: null,
            millivolts: Number(voltsA0) - Number(voltsA1),
          });
        })
        .catch(reject);
    });
  }

  async readRmsDifferentialMillivolts() {
    const sampleCount = Math.max(8, Number(this.options.rmsSampleCount) || 0);
    const samples = [];

    for (let index = 0; index < sampleCount; index += 1) {
      const measurement = await this.readDifferential01();
      samples.push(Number(measurement.millivolts));
    }

    const squaredSum = samples.reduce((sum, sample) => sum + (sample * sample), 0);
    return Math.sqrt(squaredSum / samples.length);
  }

  async openAdsBus() {
    if (!this.ads || typeof this.ads.openBus !== 'function') {
      throw new Error('ADS1115 driver ontbreekt of ondersteunt openBus niet.');
    }

    const tryOpen = async (mode) => {
      const timeoutMs = this.options.operationTimeoutMs;

      const withTimeout = (promise, label) => Promise.race([
        promise,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${label} na ${timeoutMs}ms verlopen.`)), timeoutMs);
        }),
      ]);

      if (mode === 'promise-no-args') {
        const result = this.ads.openBus();
        if (result && typeof result.then === 'function') {
          await withTimeout(result, 'ADS1115 openBus');
          return true;
        }
        return false;
      }

      if (mode === 'promise-with-bus') {
        const result = this.ads.openBus(this.options.i2cBusNumber);
        if (result && typeof result.then === 'function') {
          await withTimeout(result, 'ADS1115 openBus');
          return true;
        }
        return false;
      }

      if (mode === 'callback-no-args') {
        await withTimeout(new Promise((resolve, reject) => {
          this.ads.openBus((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }), 'ADS1115 openBus');
        return true;
      }

      if (mode === 'callback-with-bus') {
        await withTimeout(new Promise((resolve, reject) => {
          this.ads.openBus(this.options.i2cBusNumber, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }), 'ADS1115 openBus');
        return true;
      }

      return false;
    };

    // Probe several known API variants across ads1x15 releases.
    const modes = [
      'promise-no-args',
      'promise-with-bus',
      'callback-with-bus',
      'callback-no-args',
    ];

    let lastError = null;
    for (const mode of modes) {
      try {
        const opened = await tryOpen(mode);
        if (opened) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    try {
      throw new Error('Kon ADS1115 I2C bus niet openen met bekende API varianten.');
    } catch (error) {
      throw error;
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
      const timeoutMs = this.options.operationTimeoutMs;
      const millivolts = this.options.differential
        ? await Promise.race([
            this.readRmsDifferentialMillivolts(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error(`ADS1115 read na ${timeoutMs}ms verlopen.`)), timeoutMs);
            }),
          ])
        : await Promise.race([
            this.reader(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error(`ADS1115 read na ${timeoutMs}ms verlopen.`)), timeoutMs);
            }),
          ]).then(({ millivolts: rawMillivolts }) => rawMillivolts);

      const currentA = Math.abs(Number(millivolts)) / this.options.mvPerAmp;
      const powerW = currentA * this.options.lineVoltage;
      const heaterOn = currentA >= this.options.heaterOnThresholdA;

      return {
        available: true,
        reason: null,
        currentA,
        powerW,
        heaterOn,
        rawVolts: Number(millivolts),
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
