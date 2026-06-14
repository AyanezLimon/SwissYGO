# Despliegue y políticas — SwissYGO

Esta guía cubre tres cosas, una sola vez cada una:

1. [Flujo de trabajo y `master`](#1-flujo-de-trabajo-y-master) — cómo entran los cambios.
2. [Instalar el runner en el Raspberry Pi](#2-runner-self-hosted-en-el-raspberry-pi) — para que el deploy corra ahí.
3. [Configurar las variables del repo](#3-variables-del-repo) — dónde se publica el HTML.

Después de esto, el ciclo es: **Claude Code trabaja en una rama → abre PR → tú lo revisas y mergeas a master → release + deploy automáticos.**

---

## 1) Flujo de trabajo y `master`

Repo **privado**, un solo dueño. El control de qué entra a `master` no viene de la
protección de rama (que en privado requeriría GitHub Pro), sino del **flujo de trabajo**:

- **Claude Code nunca commitea directo a `master`.** Trabaja en una rama aparte
  (ej. `feature/...` o `claude/...`) y abre un **Pull Request**.
- **Tú eres el único que mergea.** Revisas el diff del PR y, si te convence, lo
  integras a `master`. Ese merge es lo único que dispara deploy + release.

Como eres el único con permiso de escritura, nadie más puede empujar a `master`; el
"solo yo apruebo" queda garantizado por el control de acceso, sin configurar nada.

> **Si algún día sumas un colaborador externo** y quieres bloquear *técnicamente* el
> push directo a `master`: o lo invitas con rol **Read** para que contribuya vía
> *fork* + PR (gratis), o pasas a **GitHub Pro ($4/mes)** para activar la protección
> de rama con review obligatoria en privado.

---

## 2) Runner self-hosted en el Raspberry Pi

**¿Por qué self-hosted y no SSH desde GitHub?** El Pi de la tienda casi siempre está detrás de NAT (sin IP pública). Un runner self-hosted **sale** hacia GitHub (conexión saliente), así que funciona sin abrir puertos, sin port-forwarding y sin exponer llaves SSH. Es la opción más segura y simple para este caso.

### Instalación (una vez)

1. En GitHub: `Settings → Actions → Runners → New self-hosted runner`.
2. Elige **Linux** y la arquitectura de tu Pi:
   - Raspberry Pi OS de 64 bits → **ARM64**
   - de 32 bits → **ARM**
   (Comprueba con `uname -m`: `aarch64` = ARM64, `armv7l` = ARM.)
3. Sigue los comandos que te muestra GitHub (descargar, `./config.sh ...`). Cuando pida **labels**, agrega:

   ```
   swissygo-pi
   ```

   (El workflow usa `runs-on: [self-hosted, swissygo-pi]`.)

4. Instálalo como **servicio** para que arranque solo con el Pi:

   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```

### Servir el archivo

El deploy solo **copia** `SwissYGO.html` a un directorio. Algo tiene que servir ese directorio por HTTP. Cualquiera sirve; ejemplos:

**Opción A — nginx (robusto):**

```bash
sudo apt install -y nginx
# sirve /var/www/swissygo en el puerto 80
sudo tee /etc/nginx/sites-available/swissygo >/dev/null <<'EOF'
server {
    listen 80 default_server;
    root /var/www/swissygo;
    index SwissYGO.html index.html;
}
EOF
sudo ln -sf /etc/nginx/sites-available/swissygo /etc/nginx/sites-enabled/default
sudo mkdir -p /var/www/swissygo
# deja que el runner escriba ahí (ajusta el usuario del runner si difiere):
sudo chown -R "$USER":"$USER" /var/www/swissygo
sudo systemctl restart nginx
```

Con esto, `DEPLOY_PATH = /var/www/swissygo` y la app queda en `http://<ip-del-pi>/`.

**Opción B — servidor mínimo (sin nginx):** un servicio systemd que corre `python3 -m http.server` sobre la carpeta del deploy. Sirve para una pantalla en kiosko; menos features que nginx.

> El usuario con el que corre el runner debe tener permiso de escritura en `DEPLOY_PATH`. Si ves "permission denied" en el deploy, ajusta `chown`/permisos de esa carpeta.

---

## 3) Variables del repo

`Settings → Secrets and variables → Actions → Variables → New repository variable`:

| Nombre | Valor (ejemplo) | Qué es |
|--------|-----------------|--------|
| `DEPLOY_PATH` | `/var/www/swissygo` | Carpeta del Pi donde el servidor web sirve el HTML |

Es una **variable** (no secret): no es información sensible y conviene verla en los logs.

---

## Verificar que todo quedó bien

1. Sube la versión en `SwissYGO.html` (`<!-- app-version: X.Y.Z -->`) dentro de un PR.
2. Aprueba y mergea a `master`.
3. En la pestaña **Actions** deberías ver el run con dos jobs:
   - `release` → verde, y un nuevo release en la pestaña **Releases** con sus notas.
   - `deploy` → verde, corriendo en el runner del Pi.
4. Abre `http://<ip-del-pi>/` y confirma que la versión desplegada es la nueva.

## Alternativa: deploy por SSH (si NO usas runner self-hosted)

Si prefieres no instalar el runner y tu Pi es alcanzable por SSH (IP fija, DDNS, o un túnel como Tailscale/Cloudflare Tunnel), se puede cambiar el job `deploy` a un runner de GitHub que use `scp`/`rsync` con una llave en `secrets`. Es más frágil (expone un acceso entrante) y requiere mantener el túnel/DDNS. Si lo quieres, pídemelo y te dejo esa variante del workflow.
