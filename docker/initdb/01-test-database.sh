#!/bin/sh
set -e

# The suite drops and recreates the `public` schema, so it gets a database of
# its own and cannot pull the tables out from under a running CMS container.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE bunbraco_test;
EOSQL
