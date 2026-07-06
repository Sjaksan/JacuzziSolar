const fs = require("fs");
const { execFileSync } = require("child_process");

const runtimePlatform = process.platform;

let gpioChip = null;
let gpioAvailable = false;
let loadError = null;
let gpioBackend = null;

function hasCommand(command) {
  try {
    execFileSync("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

if (runtimePlatform === "linux") {
  try {
    if (hasCommand("pinctrl")) {
      gpioBackend = "pinctrl";
      gpioAvailable = true;
    } else if (hasCommand("gpiodetect") && hasCommand("gpioset")) {
      const detectOutput = execFileSync("gpiodetect", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      const firstLine = detectOutput.split(/\r?\n/).find(Boolean);
      if (firstLine) {
        const [chipName] = firstLine.trim().split(/\s+/);
        gpioChip = chipName;
        gpioAvailable = Boolean(chipName);
        gpioBackend = gpioAvailable ? "gpiod" : null;
      }
    } else if (fs.existsSync("/dev/gpiochip0")) {
      gpioChip = "gpiochip0";
      gpioAvailable = true;
      gpioBackend = "gpiod";
    }
  } catch (error) {
    loadError = error;
  }
}

function getGpioStatus() {
  return {
    enabled: gpioAvailable,
    platform: runtimePlatform,
    backend: gpioBackend,
    reason: gpioAvailable
      ? null
      : "GPIO is disabled outside Linux runtime or gpiod tools are unavailable.",
    errorCode: loadError && loadError.code ? loadError.code : null,
  };
}

function writeWithPinCtrl(pinNumber, value, activeLow = false) {
  if (!gpioAvailable || gpioBackend !== "pinctrl") {
    return undefined;
  }

  const effectiveValue = activeLow ? (value ? 0 : 1) : value;
  const level = effectiveValue ? "dh" : "dl";

  try {
    execFileSync("pinctrl", ["set", String(pinNumber), "op", level], {
      stdio: "ignore",
    });
  } catch (error) {
    loadError = error;
    gpioAvailable = false;
  }

  return undefined;
}

function writeWithGpiod(pinNumber, value, activeLow = false) {
  if (!gpioAvailable || gpioBackend !== "gpiod" || !gpioChip) {
    return undefined;
  }

  const effectiveValue = activeLow ? (value ? 0 : 1) : value;

  try {
    execFileSync("gpioset", ["-m", "exit", gpioChip, `${pinNumber}=${effectiveValue}`], {
      stdio: "ignore",
    });
  } catch (error) {
    loadError = error;
    gpioAvailable = false;
  }

  return undefined;
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

  const pin = {
    writeSync(value) {
      if (gpioBackend === "pinctrl") {
        return writeWithPinCtrl(pinNumber, value, Boolean(options.activeLow));
      }
      return writeWithGpiod(pinNumber, value, Boolean(options.activeLow));
    },
    unexport() {
      return undefined;
    },
    isMock: false,
    pinNumber,
    initialValue,
    options,
  };

  try {
    pin.writeSync(initialValue);
  } catch (error) {
    pin.isMock = true;
  }

  return pin;
}

module.exports = {
  createOutputPin,
  getGpioStatus,
};
