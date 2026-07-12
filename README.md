# Jacuzzi Solar Optimizer

Lichtgewicht Node.js service voor Raspberry Pi met:
- P1 meting uitlezen
- relaissturing
- web dashboard
- lokale SQLite historie
- optionele heater detectie via SCT-013 + ADS1115
- optionele temperatuurmeting via 1-wire (bijv. DS18B20)

## Start lokaal

```bash
npm install
npm run start
```

Dashboard:
- http://<raspberrypi-ip>:3000

## Historie database

De app schrijft metingen naar:
- `history.db`

API voor grafiekdata:
- `GET /api/history?hours=24`

## Heater sensor (SCT-013 + ADS1115)

1. Schakel I2C in op je Pi:
```bash
sudo raspi-config
# Interface Options -> I2C -> Enable
```
2. Herstart de Pi.
3. Controleer I2C device:
```bash
sudo apt update
sudo apt install -y i2c-tools
i2cdetect -y 1
```
4. Controleer of ADS1115 op `0x48` zichtbaar is.
5. Zet sensor aan in environment:
- `HEATER_SENSOR_ENABLED=1`

## Temperatuursensor (1-wire, DS18B20)

1. Zet 1-wire aan op je Pi:
```bash
sudo raspi-config
# Interface Options -> 1-Wire -> Enable
```
2. Herstart de Pi.
3. Controleer of je sensor zichtbaar is:
```bash
ls /sys/bus/w1/devices
```
4. Je moet een map zien zoals `28-xxxxxxxxxxxx`.
5. Optioneel in environment:
- `TEMP_SENSOR_ENABLED=1`
- `TEMP_SENSOR_ID=28-xxxxxxxxxxxx` (specifieke sensor kiezen)
- `ONE_WIRE_BASE_PATH=/sys/bus/w1/devices`

## Maximale temperatuur

De extra verwarming stopt automatisch zodra de ingestelde maximumtemperatuur is bereikt.

- Standaard: `45` °C
- Instelling in de webinterface: `Maximale temperatuur (°C)`
- Environment variabele: `TEMP_MAX_C`

## Systemd service installeren

Er staat een installscript in:
- `deploy/install-systemd.sh`

Voer uit op de Raspberry Pi:
```bash
cd /opt/jacuzzi-solar
sudo bash deploy/install-systemd.sh /opt/jacuzzi-solar pi pi
```

Dit script doet:
- `/etc/jacuzzi-solar/jacuzzi-solar.env` maken (eerste keer)
- `/etc/systemd/system/jacuzzi-solar.service` genereren
- service enablen en starten

Pas daarna je instellingen aan in:
- `/etc/jacuzzi-solar/jacuzzi-solar.env`

Herstart service na wijziging:
```bash
sudo systemctl restart jacuzzi-solar
```

Status en logs:
```bash
systemctl status jacuzzi-solar --no-pager
journalctl -u jacuzzi-solar -f
```

## Pipeline naar Raspberry Pi (GitHub Actions)

Deze repo bevat nu een deploy workflow:
- `.github/workflows/deploy-raspberry.yml`

Bij een push naar `main` (of handmatig via `workflow_dispatch`) doet de workflow:
- bestanden syncen naar je Pi via `rsync`
- op de Pi `deploy/update-on-pi.sh` draaien
- dependencies installeren met `npm ci --omit=dev`
- systemd service installeren/updaten en herstarten

### 1) Eenmalig op de Raspberry Pi

1. Zorg dat Node.js, npm en rsync geïnstalleerd zijn.
2. Maak app map:
```bash
sudo mkdir -p /opt/jacuzzi-solar
sudo chown -R pi:pi /opt/jacuzzi-solar
```
3. Sta sudo zonder wachtwoord toe voor deploy user op alleen dit script:
```bash
sudo visudo -f /etc/sudoers.d/jacuzzi-solar-deploy
```
Met inhoud:
```text
pi ALL=(root) NOPASSWD: /bin/bash /opt/jacuzzi-solar/deploy/update-on-pi.sh *
```

### 2) GitHub Secrets instellen

Voeg in je GitHub repository secrets toe:
- `RPI_HOST` -> IP of hostnaam van je Pi
- `RPI_USER` -> SSH gebruiker (bijv. `pi`)
- `RPI_SSH_KEY` -> private key (bijv. ed25519) met toegang tot de Pi
- `RPI_APP_DIR` -> app pad op Pi (bijv. `/opt/jacuzzi-solar`)
- `RPI_APP_USER` -> runtime user voor systemd (bijv. `pi`)
- `RPI_APP_GROUP` -> runtime group (bijv. `pi`)

Tip: zet de public key uit dit keypair in `~/.ssh/authorized_keys` op de Pi.

### 3) Deployen

- Push naar `main`, of
- Start workflow handmatig in GitHub Actions.

Controle op de Pi:
```bash
systemctl status jacuzzi-solar --no-pager
journalctl -u jacuzzi-solar -n 100 --no-pager
```

## Lokale one-command deploy (zonder GitHub pipeline)

Voor deploy binnen je lokale netwerk staat er een script in:
- `deploy-local.sh`

Standaard gebruikt het:
- host: `192.168.1.151`
- user: `sjaksan`
- remote app dir: `/opt/jacuzzi-solar`

Run vanaf je projectmap:
```bash
./deploy-local.sh
```

Belangrijk:
- Run dit script zonder `sudo`.
- Bij eerste verbinding voegt het script de SSH host key automatisch toe.
- Als de host key ooit verandert (bijv. na SD-card reflash), verwijder eerst de oude key:
```bash
ssh-keygen -R 192.168.1.151
```

Met eigen waarden:
```bash
./deploy-local.sh <pi_host> <pi_user> <remote_dir> <app_user> <app_group>
```

Voorbeeld:
```bash
./deploy-local.sh 192.168.1.151 sjaksan /opt/jacuzzi-solar sjaksan sjaksan
```

Opmerking over snelheid:
- Eerste deploy kan nog traag zijn.
- Daarna slaat `deploy/update-on-pi.sh` dependency-installatie over als `package-lock.json` niet gewijzigd is.
- De deploy-cache staat op de Pi in `.deploy-state` en blijft nu behouden tussen deploys.

Snelle deploy zonder npm stap (voor alleen code/UI wijzigingen):
```bash
SKIP_REMOTE_NPM_INSTALL=1 ./deploy-local.sh
```

Lage schijfruimte op Pi:
- `deploy/update-on-pi.sh` gebruikt standaard npm cache in `/var/cache/jacuzzi-solar-npm` (op disk, niet in RAM).
- Bij te weinig vrije ruimte stopt het script met een duidelijke melding.
- Drempel is standaard 256MB vrij.

Optioneel tunen:
```bash
# Andere cache locatie (bijv. usb of grotere partitie)
ssh sjaksan@192.168.1.151 "sudo NPM_CACHE_DIR=/var/tmp/jacuzzi-npm-cache bash /opt/jacuzzi-solar/deploy/update-on-pi.sh /opt/jacuzzi-solar sjaksan sjaksan"

# Vrije-ruimte drempel aanpassen (KB)
ssh sjaksan@192.168.1.151 "sudo MIN_FREE_KB=131072 bash /opt/jacuzzi-solar/deploy/update-on-pi.sh /opt/jacuzzi-solar sjaksan sjaksan"
```

Zelfde tuning via lokaal deployscript:
```bash
REMOTE_NPM_CACHE_DIR=/var/tmp/jacuzzi-npm-cache ./deploy-local.sh
REMOTE_MIN_FREE_KB=131072 ./deploy-local.sh
```

Force-opties bij troubleshooting:
```bash
FORCE_NPM_INSTALL=1 ./deploy-local.sh
FORCE_SQLITE_REBUILD=1 ./deploy-local.sh
```

Waarom niet lokaal builden en dan syncen?
- Native Node modules (zoals `sqlite3` en I2C-gerelateerde dependencies) zijn platform/architectuur-specifiek.
- Build op x86 laptop werkt meestal niet op ARM Raspberry Pi.
- Daarom: dependencies op de Pi bouwen en daarna snelle deploys doen met cache en `SKIP_REMOTE_NPM_INSTALL` wanneer mogelijk.

Direct op de Pi met flags:
```bash
sudo bash /opt/jacuzzi-solar/deploy/update-on-pi.sh /opt/jacuzzi-solar sjaksan sjaksan --force-npm-install
sudo bash /opt/jacuzzi-solar/deploy/update-on-pi.sh /opt/jacuzzi-solar sjaksan sjaksan --force-sqlite-rebuild
```

## Belangrijke env variabelen

- `WEB_PORT=3000`
- `P1_IP=192.168.1.171`
- `HEATER_SENSOR_ENABLED=0`
- `HEATER_CURRENT_THRESHOLD_A=1.0`
- `LINE_VOLTAGE_V=230`
- `ADS1115_I2C_BUS=1`
- `ADS1115_ADDRESS=72`
- `ADS1115_CHANNEL=0`
- `SCT_MV_PER_AMP=10`
- `TEMP_SENSOR_ENABLED=0`
- `TEMP_SENSOR_ID=`
- `ONE_WIRE_BASE_PATH=/sys/bus/w1/devices`
