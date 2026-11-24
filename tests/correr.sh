#!/usr/bin/env bash
# Corre las pruebas contra un Worker local nuevo (base de datos vacía, modelos simulados)
set -e
cd "$(dirname "$0")/.."
rm -rf tests/.state
npx wrangler dev --config tests/wrangler.test.toml --port 8787 --persist-to tests/.state --ip 127.0.0.1 > tests/.wrangler.log 2>&1 &
WPID=$!
# En Windows (Git Bash) se cierra todo el árbol (npx → wrangler → workerd) con taskkill
WINPID=$(cat /proc/$WPID/winpid 2>/dev/null || true)
trap 'if [ -n "$WINPID" ] && command -v taskkill >/dev/null; then taskkill //PID $WINPID //T //F >/dev/null 2>&1; fi; kill $WPID 2>/dev/null; pkill -P $WPID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -s 127.0.0.1:8787/health >/dev/null && break; sleep 1; done
# --test-force-exit: si una prueba falla y deja un servidor abierto, el corredor no se queda colgado
BASE=http://127.0.0.1:8787 node --test --test-timeout=60000 --test-force-exit tests/plataforma.test.mjs
