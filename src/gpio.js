const runtimePlatform = process.platform;

let GpioCtor = null;
let loadError = null;

if (runtimePlatform === "linux") {
  try {
    ({ Gpio: GpioCtor } = require("onoff"));
  } catch (error) {
    loadError = error;
  }
}

const gpioAvailable = Boolean(GpioCtor) && runtimePlatform === "linux";

function getGpioStatus() {
  return {
    enabled: gpioAvailable,
    platform: runtimePlatform,
    reason: gpioAvailable
      ? null
      : "GPIO is disabled outside Linux runtime. Use Linux device runtime for hardware control.",
    errorCode: loadError && loadError.code ? loadError.code : null,
  };
}

function createOutputPin(pinNumber, initialValue = 0, options = {}) {
  if (!gpioAvailable) {
    return {
      writeSync() {
        return undefined;
      },
      unexport() {
        return undefined;
      },
      isMock: true,
      pinNumber,
      initialValue,
      options,
    };
  }

  const pin = new GpioCtor(pinNumber, "out", {
    activeLow: Boolean(options.activeLow),
    reconfigureDirection: options.reconfigureDirection,
  });

  pin.writeSync(initialValue);
  return pin;
}

module.exports = {
  createOutputPin,
  getGpioStatus,
};
