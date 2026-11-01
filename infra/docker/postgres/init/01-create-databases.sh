#!/usr/bin/env bash
# Runs once, on first start of an empty data volume (docker-entrypoint-initdb.d).
# Creates one database and one login role per service, so services cannot read each other's data.
set -euo pipefail

create_service_database() {
  local database_name="$1"
  local password="$2"
  local role_name="${database_name}_service"

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    --set=role_name="$role_name" --set=database_name="$database_name" --set=password="$password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role_name', :'password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database_name', :'role_name') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'database_name') \gexec
SQL
  echo "created database '${database_name}' owned by role '${role_name}'"
}

create_service_database auth "${AUTH_DB_PASSWORD:?AUTH_DB_PASSWORD is required}"
create_service_database catalog "${CATALOG_DB_PASSWORD:?CATALOG_DB_PASSWORD is required}"
create_service_database booking "${BOOKING_DB_PASSWORD:?BOOKING_DB_PASSWORD is required}"
create_service_database payment "${PAYMENT_DB_PASSWORD:?PAYMENT_DB_PASSWORD is required}"
create_service_database notification "${NOTIFICATION_DB_PASSWORD:?NOTIFICATION_DB_PASSWORD is required}"
