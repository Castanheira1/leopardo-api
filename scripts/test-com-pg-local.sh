#!/usr/bin/env bash
#
# Sobe um PostgreSQL LOCAL e efêmero, aplica o schema.sql e roda a suíte de
# integração (tests/integration.test.js) contra ele. Ao final, derruba o banco.
#
# Não toca no banco de produção — cria um cluster descartável em /tmp.
# Requer os binários do PostgreSQL (initdb/pg_ctl) e Node >= 22 instalados.
#
# Uso:  npm run test:pg     (ou:  bash scripts/test-com-pg-local.sh)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGPORT="${PGPORT:-5433}"
WORK="$(mktemp -d /tmp/vagao-pg.XXXXXX)"
PGDATA="$WORK/data"
PGSOCK="$WORK/sock"
DB="vagao_test"

# Localiza os binários do servidor Postgres (initdb/pg_ctl não ficam no PATH em Debian/Ubuntu)
PGBIN="$(dirname "$(command -v initdb 2>/dev/null || true)")"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "ERRO: binários do PostgreSQL (initdb/pg_ctl) não encontrados." >&2
  exit 2
fi

# initdb/postgres não rodam como root: usa um usuário 'pg' descartável se preciso
RUN=""
if [ "$(id -u)" = "0" ]; then
  id pg >/dev/null 2>&1 || useradd -m pg
  chown -R pg "$WORK"
  RUN="sudo -u pg"
fi

cleanup() {
  $RUN "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> initdb ($WORK)"
mkdir -p "$PGSOCK"; [ -n "$RUN" ] && chown -R pg "$WORK"
$RUN "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null

echo "==> subindo PostgreSQL na porta $PGPORT"
$RUN "$PGBIN/pg_ctl" -D "$PGDATA" -o "-c listen_addresses='' -k $PGSOCK -p $PGPORT" -w start >/dev/null

echo "==> criando banco $DB e aplicando schema.sql"
$RUN "$PGBIN/createdb" -h "$PGSOCK" -p "$PGPORT" -U postgres "$DB"
$RUN "$PGBIN/psql" -v ON_ERROR_STOP=1 -h "$PGSOCK" -p "$PGPORT" -U postgres -d "$DB" -f "$ROOT/schema.sql" >/dev/null

export DATABASE_URL="postgresql://postgres@localhost/$DB?host=$PGSOCK&port=$PGPORT"
export JWT_SECRET="${JWT_SECRET:-test-secret-com-mais-de-32-caracteres-aqui-ok}"

echo "==> rodando a suíte de integração"
node "$ROOT/tests/integration.test.js"
