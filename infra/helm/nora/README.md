# Nora Helm Chart

Installs the full Nora control plane on Kubernetes: the nginx edge, the three
Next.js frontends (marketing, operator dashboard, admin), the backend API, the
provisioner and backup workers, and — by default — in-chart PostgreSQL 15 and
Redis 7 built on the official images.

## Quick start

```bash
helm install nora ./infra/helm/nora \
  --namespace nora --create-namespace \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set secrets.encryptionKey="$(openssl rand -hex 32)" \
  --set secrets.backupEncryptionKey="$(openssl rand -hex 32)" \
  --set secrets.apiKeyHashSecret="$(openssl rand -hex 32)" \
  --set secrets.dbPassword="$(openssl rand -hex 24)" \
  --set publicUrl="https://nora.example.com" \
  --set ingress.enabled=true --set ingress.host="nora.example.com"
```

No insecure defaults ship in the chart: installs fail fast until the five
secrets are provided (or `secrets.existingSecret` points at a Secret carrying
`JWT_SECRET`, `ENCRYPTION_KEY`, `NORA_BACKUP_ENCRYPTION_KEY`,
`NORA_API_KEY_HASH_SECRET`, `DB_PASSWORD`).

> **Save your secrets.** The `--set` form above generates secrets that live only
> inside the release. `helm uninstall` deletes the generated Secret, but the
> postgres data PVC and the `nora-backups` PVC are retained
> (`helm.sh/resource-policy: keep`). A reinstall then generates *new* secrets
> that cannot decrypt the retained data or match the kept DB password. For any
> install you intend to keep, manage the five secrets yourself and pass them via
> `secrets.existingSecret`, or back up the generated Secret immediately.

Without an Ingress: `kubectl -n nora port-forward svc/nora-nginx 8080:80` and
open http://localhost:8080. The first user to sign up becomes the platform
admin.

## Key values

| Value | Default | Meaning |
| --- | --- | --- |
| `global.imageRegistry` | `ghcr.io/solomon2773` | Registry for the published `nora-*` images |
| `global.imageTag` | `v<appVersion>` | Image tag for all Nora services |
| `publicUrl` | `http://localhost:8080` | Public origin; feeds `NEXTAUTH_URL` + `CORS_ORIGINS` |
| `enabledBackends` | `k8s` | Agent deploy targets (see limitations) |
| `secrets.*` / `secrets.existingSecret` | — | Required credentials (see above) |
| `backendEnv` | `{}` | Extra env for backend-api + workers (anything from `.env.example`) |
| `kubeconfigs.existingSecret` | `""` | Secret of kubeconfig files mounted at `/kubeconfigs` for agent deploy targets |
| `postgresql.enabled` / `redis.enabled` | `true` | In-chart data stores; disable and fill `*.external.*` to bring your own |
| `backupsVolume.*` | RWO 10Gi | Shared volume for managed local backups |
| `ingress.*` | disabled | Ingress in front of the `nora-nginx` Service |
| `nginx.service.type` | `ClusterIP` | Switch to `LoadBalancer`/`NodePort` to expose directly |

## Design notes

- **One release per namespace.** Services use fixed compose-parity names
  (`backend-api`, `postgres`, `redis`, `frontend-dashboard`, …) so the bundled
  nginx config and the app's connection defaults work unchanged.
- **`files/nginx-k8s.conf`** mirrors the repo-root `nginx.conf` routing with
  static Service upstreams. When `nginx.conf` routing changes, update it in the
  same PR.
- **`files/db_schema.sql`** is a vendored copy of `backend-api/db_schema.sql`
  used by the in-chart postgres initdb. CI (`npm run ci:validate-infra`) fails
  when the copies drift; refresh with
  `cp backend-api/db_schema.sql infra/helm/nora/files/db_schema.sql`.

## Limitations on Kubernetes

- **Docker deploy target is unavailable** — the provisioner has no Docker
  socket in a pod. `ENABLED_BACKENDS` defaults to `k8s`; register clusters
  under Admin → Kubernetes and mount their kubeconfigs via
  `kubeconfigs.existingSecret`.
- **In-place release upgrades (Admin UI) are a Docker Compose feature.**
  Upgrade with `helm upgrade nora <chart> --reuse-values` instead.
- **Local backup storage** uses one PVC shared by backend-api and
  worker-backup. `ReadWriteOnce` only works when both pods schedule onto the
  same node (k3s/Kind/single-node). On multi-node clusters use a
  `ReadWriteMany` storage class or configure S3/SSH backup storage and set
  `backupsVolume.enabled=false`.

## Validation

- `npm run ci:validate-infra` — helm lint + `helm template | kubeconform
  -strict` + schema drift guard (runs in CI Security on every PR).
- `infra/helm/scripts/kind-smoke.sh` — full install on a local Kind cluster
  with edge probes (`/api/health`, `/`, `/app`, `/admin`).
