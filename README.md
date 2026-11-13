# cardinal-manager

Sandbox Manager de Alice. **Solo habla Docker**: recibe una orden de provision
del backend, ejecuta `alice-ops/scripts/deploy.sh` con `execFile` y avisa al
backend cuando el contenedor esta listo. No toca PostgreSQL, no conoce Prisma y
nunca recibe el token en claro (solo su hash).

```
backend  --POST /provision {jobId, sandboxId, userId, tokenSha256, apiKey?}-->  manager
manager  --execFile-->  alice-ops/scripts/deploy.sh --json --node <nodo>
manager  --POST {BACKEND_URL}/internal/provision/ready {jobId, ok, ...}-->  backend
```

## Requisitos

- Node 22+ (probado con Node 24).
- `alice-ops` canonico en `5167c4d` (`Add manager-driven sandbox deployment`).
  Su suite: `122 passed, 0 failed`.
- Docker disponible en el host del manager (para `/readyz` y `/provision/orphans`).

## Configuracion (`.env`)

| Variable | Obligatoria | Default | Uso |
|---|---|---|---|
| `MANAGER_PORT` | no | `8090` | Puerto HTTP. |
| `INTERNAL_TOKEN` | **si** (32+) | — | `X-Internal-Token` del backend. |
| `BACKEND_URL` | no | `http://backend:3000` | Base del callback. |
| `ALICE_OPS_DIR` | **si** | — | Ruta absoluta con `scripts/deploy.sh`. |
| `ALICE_NODE` | no | `local` | Valor de `--node`. |
| `PROVISION_TIMEOUT_MS` | no | `180000` | Timeout de `deploy.sh`. |
| `LETTA_TAG` | **si** | — | Tag fijo de la imagen (no `latest`). Compartido. |
| `LITELLM_BASE_URL` | **si** | — | URL compartida; hoy falsa (`http://litellm:4000`). |
| `LITELLM_API_KEY` | no | — | Fallback si el body no trae `apiKey`. |
| `LOG_LEVEL` | no | `info` | `fatal..silent`. |
| `NODE_ENV` | no | `development` | `development\|test\|production`. |

`INTERNAL_TOKEN`, `ALICE_OPS_DIR`, `LETTA_TAG` y `LITELLM_BASE_URL` no tienen
default: sin ellos el proceso no arranca.

## Contrato HTTP

Todos los endpoints exigen `X-Internal-Token`, salvo `/readyz`.

### `POST /provision`

```json
{
  "jobId": "uuid",
  "sandboxId": "string",
  "userId": "uuid",
  "tokenSha256": "64 hex (se normaliza a minusculas)",
  "apiKey": "sk-... (opcional)"
}
```

- `apiKey` es la virtual key de LiteLLM **por usuario**. Si falta, se usa
  `LITELLM_API_KEY` del `.env`; si tampoco existe, `400`.
- `202 {jobId}`; el trabajo corre en background.
- `400 {error:{code:'VALIDATION_ERROR'}}` si falta o es invalido.
- `409 {error:{code:'JOB_EXISTS'}}` si el `jobId` ya existe en el Map
  (activo o terminal, dentro del TTL de 1 h). Un retry debe traer un jobId nuevo.

### `GET /provision/:jobId`

`200 {jobId, status, containerName?, internalHost?, port?, transport?,
containerId?, code?, message?}` o `404 JOB_NOT_FOUND` (no existe o expiro a 1 h).

Nunca devuelve `apiKey`, `tokenSha256` ni `userId`.

### `GET /provision/orphans`

Ejecuta `docker ps -a --filter label=alice.jobId --format '{{json .}}'` y
devuelve los contenedores cuyo `alice.jobId` no esta en el Map:

```json
{"containers":[{"name":"alice-x","containerId":"...","labels":"alice.jobId=...,alice.sandboxId=...","status":"Up 3 minutes"}]}
```

`labels` es el string crudo que entrega Docker.

### `GET /readyz`

`200 {ok:true}` si `docker version` responde en menos de 3 s; `503 {ok:false}`
si no. Sin auth.

## Ejecucion del provision

- `execFile(deploy.sh, ['--json','--node',<nodo>], {env, timeout, maxBuffer})`,
  nunca `execFileSync`, nunca shell, nunca el hash en argv.
- El hash y la `apiKey` van por **env**: `WS_TOKEN_SHA256`, `LITELLM_API_KEY`,
  `LITELLM_BASE_URL`, `LETTA_TAG`, `ALICE_JOB_ID`, `ALICE_USER_ID`,
  `ALICE_SANDBOX_ID`. Se borra `INTERNAL_TOKEN` del entorno heredado.
- Timeout -> `READY_TIMEOUT`. Exit 2 -> `INVALID_INPUT`. Exit 1 con JSON valido
  -> se busca el item de `results[]` de **este** `sandboxId` y se usa su `code`.
  Exit 1 sin JSON -> `BAD_MANAGER_OUTPUT` (primeros 500 chars, filtrados).
- Callback al backend **siempre**, con 3 reintentos y backoff 1 s/4 s/16 s
  (4 intentos). Si falla, el job conserva su resultado, queda
  `callbackDelivered=false` y el contenedor **no** se marca fallido.

## Tests

```bash
npm test
npx tsc --noEmit
npm run build
```

37 tests: contrato 17-30 (auth, validacion, hash por env, exit codes, results[],
orphans, callback, timeout, 409), mas apiKey/fallback, redaccion de secretos,
`/readyz` y TTL del store.

## Notas de integracion

- El commit `5167c4d` de `alice-ops` exige `LETTA_TAG`, `LITELLM_BASE_URL` y
  `LITELLM_API_KEY` en modo manager. El manager los suministra por env; la
  `apiKey` viaja por el body (opcion 3) y `LETTA_TAG`/`LITELLM_BASE_URL` por
  `.env`.
- En esta maquina Windows no hay Docker: `node dist/main.js` arranca y
  `/readyz` responde `503 {ok:false}`. El camino `200` esta cubierto por el test
  con el fake de `execFile`.
- En Windows `execFile` no puede ejecutar `deploy.sh` (`.sh`); un provision real
  da `BAD_MANAGER_OUTPUT` con `spawn EFTYPE`. En Linux corre normalmente.
