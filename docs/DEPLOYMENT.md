# Despliegue y políticas — SwissYGO

Esta guía cubre tres cosas, una sola vez cada una:

1. [Proteger `master`](#1-proteger-master-solo-aprobado-por-ti) — nadie mergea sin tu aprobación.
2. [Instalar el runner en el Raspberry Pi](#2-runner-self-hosted-en-el-raspberry-pi) — para que el deploy corra ahí.
3. [Configurar las variables del repo](#3-variables-del-repo) — dónde se publica el HTML.

Después de esto, el ciclo es: **PR → tu aprobación → merge a master → release + deploy automáticos.**

---

## 1) Proteger `master` (solo aprobado por ti)

Esto bloquea pushes directos y obliga a que todo pase por un PR que **tú** apruebes.

`Settings → Branches → Add branch ruleset` (o *Branch protection rules*). Crea una regla para `master` con:

- ✅ **Require a pull request before merging**
  - ✅ Require approvals: **1**
  - ✅ **Require review from Code Owners** → usa el archivo `.github/CODEOWNERS`
  - ✅ Dismiss stale approvals when new commits are pushed
- ✅ **Require status checks to pass before merging**
  - Marca el check **`release`** (aparece tras el primer run del workflow) para que no se pueda mergear si el release falla.
- ✅ **Block force pushes**
- ✅ **Restrict who can push** → solo tú (opcional, refuerza el bloqueo de pushes directos).

### Importante para un repo de un solo mantenedor

GitHub **no** te deja aprobar tu propio PR. Tienes dos caminos:

- **Recomendado (velocidad):** activa la regla pero deja **"Do not require approval from someone other than the author"** / permite que los **administradores** mergeen. Así tus propios PRs los mergeas tú, y los de cualquier colaborador externo **sí** requieren tu review (vía CODEOWNERS). En la práctica: "solo aprobado por mí" para todo lo que no venga de ti.
- **Estricto (gate también para ti):** deja la regla sin bypass de administradores. Entonces necesitarás un segundo colaborador (o un segundo usuario) para aprobar cualquier PR, incluidos los tuyos. Solo tiene sentido si más gente toca el repo.

> Edita `.github/CODEOWNERS` y reemplaza `@TU-USUARIO-GITHUB` por tu handle real antes de confiar en la review obligatoria.

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
