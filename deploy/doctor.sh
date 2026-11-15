#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  printf '%s\n' 'Usage: deploy/doctor.sh COMPOSE_PROJECT /absolute/installation.env' >&2
  exit 2
fi

project=$1
settings=$2
deploy=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
compose() {
  docker compose --env-file "$settings" -p "$project" -f "$deploy/compose.yaml" "$@"
}

docker compose version
compose config --quiet
compose ps
compose exec -T workboard node -e 'const r=await fetch("http://127.0.0.1:4180/api/health"); if(!r.ok)process.exit(1);console.log("AW",await r.json());'
compose exec -T dsh node -e 'const r=await fetch("http://127.0.0.1:3081/orchestrator/api/state",{headers:{"x-orchestrator-request":"1"}});if(!r.ok)process.exit(1);const s=await r.json();console.log("DSH",JSON.stringify({setup:s.setup?.problem ?? null}));'
compose exec -T dsh git --version
compose exec -T dsh node --version
compose exec -T dsh lark-cli --version
if command -v codex >/dev/null && codex queue --help >/dev/null 2>&1; then
  printf '%s\n' 'Owner host: Codex queue CLI available'
else
  printf '%s\n' 'Owner host: verify codex queue --help on the machine running Relay'
fi
printf '%s\n' 'Service checks complete. Verify model, repository, Feishu and Owner continuation with a separate test task.'
