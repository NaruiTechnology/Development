# Ionbeam Remote VM Setup

This is the production setup for `ionbeamtech.com` on an Ubuntu VM.

The stack is:

* `nginx` terminates TLS and serves as the public entrypoint
* `ionbeam-web.service` runs the Node backend on `127.0.0.1:4000`
* `glasgow-svc.service` runs the FastAPI device service on `127.0.0.1:8765`

If you want a one-shot mobility-only bootstrap for a fresh VM, use
[mobility-only-bootstrap.sh](./mobility-only-bootstrap.sh). It installs
`nginx`, provisions TLS, and can run the web stack in `MOCK=1` mobility mode
when the Glasgow hardware service is not present.

The service unit uses `IONBEAM_WEB_ROOT` plus `%h`. Change `User=ionbeam` to
the actual login user on your VM if needed, and if your checkout lives
somewhere else, update the single `IONBEAM_WEB_ROOT` line in the unit.

## 1. Install nginx

On the remote VM:

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable --now nginx
sudo systemctl status nginx
```

If you use a firewall:

```bash
sudo ufw allow 'Nginx Full'
```

## 2. Install the backend service file

Copy [ionbeam-web.service](./ionbeam-web.service) to `/etc/systemd/system/ionbeam-web.service`.

Then edit the backend `.env` file so it matches production:

```bash
PORT=4000
STATIC_DIR=../frontend/dist
PROXY_TARGET_HTTP=http://127.0.0.1:8765
PROXY_TARGET_WS=ws://127.0.0.1:8765
IONBEAM_MOBILITY_ONLY=1
GLASGOW_CONFIG=/absolute/path/to/streamData.json
GLASGOW_RESTART_CMD=/absolute/path/to/restart-glasgow-service.sh
IONBEAM_BACKEND_RESTART_CMD=sudo systemctl restart ionbeam-web.service
```

Enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ionbeam-web.service
sudo systemctl status ionbeam-web.service
```

If you run the workflow's production path, make sure the user has permission
to run `sudo systemctl restart ionbeam-web.service` without an interactive
password prompt.

## 3. Install the nginx site

Copy [nginx/ionbeamtech.com.conf](./nginx/ionbeamtech.com.conf) to:

```bash
/etc/nginx/sites-available/ionbeamtech.com.conf
```

Then enable it:

```bash
sudo ln -s /etc/nginx/sites-available/ionbeamtech.com.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 4. Get a TLS certificate

The nginx config assumes Let’s Encrypt paths. On Ubuntu, install certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ionbeamtech.com -d www.ionbeamtech.com
```

Certbot will update the nginx vhost and install certificate paths under:

```bash
/etc/letsencrypt/live/ionbeamtech.com/
```

## 5. Verify

```bash
curl -I https://ionbeamtech.com/control
curl https://ionbeamtech.com/healthz
sudo systemctl status ionbeam-web.service
sudo journalctl -u ionbeam-web.service -f
sudo journalctl -u nginx -f
```

## Notes

* The public site should be `https://ionbeamtech.com/`
* The app routes are:
  * `/` or `/control` -> control view
  * `/report` -> management report
  * `/mobility` -> mobility portal
* Set `IONBEAM_MOBILITY_ONLY=1` in the backend `.env` when you want the
  server to redirect `/` and `/control` into the mobility portal.
* WebSocket scan routes stay under `/ws/scan/...`
