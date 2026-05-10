# Ion Beam Technology — Web Control Panel

A browser-based control surface for the Ion Beam Technology Ltd. Glasgow-based
beam control system. Wraps the existing `glasgow_service` FastAPI process with
a Node.js/TypeScript proxy and a React + Redux + TypeScript front-end.

---

## What this gives you

* **Run / Pause / Stop** raster and vector scans from a browser.
* **Parameter forms** for resolution, dwell, latency, frame-blank, output mode,
  pre-process, custom vector points — exactly the fields the FastAPI
  `RasterRequest` / `VectorRequest` Pydantic models accept.
* **Live image** on a canvas that renders raster pixels as the chunks stream
  in over a WebSocket. Vector mode plots received points.
* **Validation report** and **CSV path** echoed back from the blocking REST
  endpoints so you keep the wet-run validation behaviour the existing pytest
  suite uses.
* **Status bar** wired to `GET /status` (state, scans completed, chunks in
  flight).
* **Mock mode** on the Node proxy (`MOCK=1`) — runs the whole UI without a
  Glasgow attached, so this can be demoed and integration-tested separately
  from hardware.

## Layout

```
ionbeam-web/
├── README.md                 ← you are here
├── glasgow_service/          ← (your existing FastAPI service, unmodified)
│
├── backend/                  ← Node 20+ / TypeScript / Express + ws
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── src/
│       ├── server.ts         ← entry point
│       ├── config.ts         ← env loader (PROXY_TARGET, MOCK, GLASGOW_TOKEN)
│       ├── restProxy.ts      ← /api/* → FastAPI
│       ├── wsProxy.ts        ← /ws/scan/{raster,vector}/stream → FastAPI
│       └── mockHardware.ts   ← synthetic raster/vector chunks for demos
│
└── frontend/                 ← React 18 / Redux Toolkit / TS / Vite
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── store/            ← RTK store + slices + RTK Query
        ├── components/       ← ScanControls, ImageCanvas, etc.
        ├── types/            ← shared TS types matching Pydantic models
        └── styles/           ← Ion Beam Tech-themed CSS
```

## Running everything

You need three processes in dev. Each has its own README; here is the
quick path.

```bash
# 1) Glasgow FastAPI service (your existing project) — port 8765
export GLASGOW_CONFIG=/home/vboxuser/Project/IobeamTech/Development/GlasgowDataIO/Json/streamData.json

# Optional: turn on bearer auth
# export GLASGOW_TOKEN=$(openssl rand -hex 32)
uvicorn glasgow_service.api:app --host 127.0.0.1 --port 8765

# 2) Node proxy / static server — port 4000
cd backend
npm install
cp .env.example .env          # edit if your token / port differ
npm run dev

# 3) React dev server — port 5173, proxies /api and /ws to localhost:4000
cd ../frontend
npm install
npm run dev
```

Open <http://localhost:5173>.

### Without hardware (demo / CI)

```bash
cd backend
MOCK=1 npm run dev            # backend invents raster + vector chunks
cd ../frontend
npm run dev
```

The UI behaves identically — useful when bringing up new clients or
demonstrating the workflow.

### Production build

```bash
cd frontend && npm run build  # emits frontend/dist/
cd ../backend && npm run build && npm start
```

The Node server then serves `frontend/dist/` and proxies `/api` + `/ws` to
the FastAPI process. Put it behind nginx/Caddy for TLS.

## Why this shape

* The browser **never sees `GLASGOW_TOKEN`**. The Node proxy injects the
  `Authorization: Bearer …` header server-side. This is the same posture the
  `examples/raster_custom.py` REST client takes — token in env, never in URL.
* The Node proxy lets you keep the FastAPI service bound to `127.0.0.1` and
  expose only the web app on the public interface.
* Mock mode lives at the proxy layer (not in the React app) so the front-end
  has exactly one code path, and the mock honours the same WebSocket message
  format (`{event:"done", chunks:N}`) the real service emits.

## Wiring summary

| User action            | Frontend                          | Backend (Node)                    | Glasgow service                       |
| ---------------------- | --------------------------------- | --------------------------------- | ------------------------------------- |
| Page load              | `GET /api/status`, `/api/defaults`| Forwards                          | `GET /status`, `/defaults`            |
| Run raster (live)      | open `ws://…/ws/scan/raster/stream` | Pipes WS to upstream            | `WS /scan/raster/stream`              |
| Run raster (validated) | `POST /api/scan/raster/run`       | Forwards with bearer              | `POST /scan/raster/run` → `ScanResult`|
| Pause                  | `ws.close(1000)`                  | Drops upstream socket             | `WebSocketDisconnect` → cancels gen   |
| Stop                   | `ws.close(1000)` + clear state    | same                              | same                                  |
| Reconnect device       | button → `POST /api/admin/reconnect`| Forwards                        | `POST /admin/reconnect`               |
