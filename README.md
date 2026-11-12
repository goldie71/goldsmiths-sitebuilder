# Goldsmiths Site & AI Builder

Describe a website and a private AI on your own NAS writes it. Then add pictures,
or generate them on the box, and check whether a domain is free. Built for the
TerraMaster TOS App Center. No cloud AI, no account, no subscription, no API keys
needed for the core job.

## What it does
- **Build** (port 8090): a brief becomes a single-page site, served at `/s/<name>`.
  The AI runs in a second container beside the app on the same NAS.
- **Pictures**: upload your own, or generate them if you point `IMAGE_API_URL` at
  anything that speaks the OpenAI images API (LocalAI, ComfyUI bridge, or a hosted
  endpoint). Unset means the feature reports itself as not configured.
- **Domains**: check a name against public registry data (RDAP, keyless), or against
  GoDaddy if you supply credentials. Selling a domain needs `STRIPE_SECRET_KEY`;
  card details are typed on Stripe's page and never reach the NAS.
- **Your data**: `/api/my-data` shows everything held, `/api/my-data/export` gives a
  copy, `DELETE /api/my-data` erases it. See [PRIVACY.md](PRIVACY.md).

The app does **not** host a site publicly or point DNS at one. It builds and serves
pages on your own network.

## Requirements
x86_64 NAS with Docker, 8 GB RAM or more. The model (`qwen2.5-coder:1.5b` by default)
downloads once on first build; set `SITE_MODEL` to use a larger one.

## Repository layout
```
config.ini                   app identity, entry point, version
docker-compose.yml           builder + ollama, named volumes, both non-root
webui.bz2                    front-end bundle (tar.bz2 containing index.html)
goldsmiths-sitebuilder.svg   icon
goldsmiths-sitebuilder.lang  store text, 14 locales
README.md  PRIVACY.md  LICENCE
app/                         image build context
  Dockerfile                 node:22-alpine, USER 1000:1000
  entrypoint.sh              waits for the model, then exec node (receives SIGTERM)
  server.js                  express app: build, uploads, images, domains, data rights
```

## Build and run
```sh
docker build -t goldie71/goldsmiths-sitebuilder:1.2.5 ./app
docker compose up -d          # uses the image tag above
```

## Build the store package
```sh
tar czf goldsmiths-sitebuilder-1.2.5.tar.gz config.ini docker-compose.yml webui.bz2 \
  goldsmiths-sitebuilder.svg goldsmiths-sitebuilder.lang README.md PRIVACY.md
```

## Security posture
Both containers run as uid 1000; there is no root container, no privileged mode, no host
network and no runtime `chown`. Data lives in named volumes. Both services handle SIGTERM
and exit cleanly within the 25 s grace period. Secrets (`IMAGE_API_KEY`,
`STRIPE_SECRET_KEY`, `GODADDY_KEY`) are read from the environment and never written to disk.

## Licence
MIT.
