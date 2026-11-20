# scripts/linux – Linux-Testumgebung (WP-100 E8, WP-101)

Docker-Image mit Ubuntu, offiziellem Node 26, pnpm, git und Google Chrome, um die Linux-Pfade von Parallax unter
Windows zu prüfen. Nie Teil eines Releases. Owner: Koordinator.

| Datei | Inhalt |
| --- | --- |
| `Dockerfile` | Stufe `common` (Ubuntu `UBUNTU`, Node `NODE_VERSION` mit SHA-256-Prüfung, pnpm `PNPM_VERSION`, Chrome per `CHROME=1`, Benutzer `ubuntu`), Stufe `systemd` (systemd als PID 1, nur für Spikes), Standard-Stufe `base` (als `ubuntu`) |

## Bauen
```powershell
docker build -t parallax-linux:24.04 --build-arg UBUNTU=24.04 scripts/linux
docker build -t parallax-linux:26.04 --build-arg UBUNTU=26.04 scripts/linux
docker build -t parallax-linux:24.04-systemd --target systemd --build-arg UBUNTU=24.04 scripts/linux
```
Ohne Chrome (schneller, für Spikes): `--build-arg CHROME=0`.

## Laufen lassen (Ressourcenregel ADR-154)
- Jeder Container mit Grenzen: `--cpus=4 --memory=8g` für Spikes, für schwere Läufe (`pnpm check`, `e2e`) höchstens
  die Hälfte der CPUs. Ein schwerer Lauf zur Zeit – auch nicht parallel zu einem schweren Lauf unter Windows.
- Immer `--rm` und `--init` (sonst bleiben verwaiste Prozesse Zombies unter PID 1); Container nach dem Lauf beenden
  (`docker ps` leer).
- Die Windows-`node_modules` nie einbinden: Der Container braucht eigene mit Linux-Binaries (Volume).
- Das systemd-Image braucht `--privileged --cgroupns=host` und läuft im Hintergrund (`-d`); danach `docker rm -f`.

```powershell
docker run --rm -it --init --cpus=4 --memory=8g parallax-linux:24.04 bash
```
