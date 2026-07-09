import os
import sys
from logging.config import fileConfig
from pathlib import Path

from dotenv import load_dotenv
from geoalchemy2 import alembic_helpers
from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

# Make `backend/` importable regardless of the cwd this is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from db.base import Base  # noqa: E402
from db import models  # noqa: E402,F401  (registers all models on Base.metadata)

load_dotenv(Path(__file__).resolve().parents[3] / ".env")

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def include_object(object, name, type_, reflected, compare_to):
    """Filter what autogenerate is allowed to diff.

    The postgis/postgis Docker image auto-creates postgis_tiger_geocoder and
    postgis_topology extension tables (county, state, edges, faces, topology,
    layer, ~30 more) directly in `public` on database init. Without this
    filter, autogenerate proposes DROP TABLE for all of them since they're not
    in our SQLAlchemy metadata. Standard Alembic pattern: skip any reflected
    table that has no corresponding model (compare_to is None) instead of
    treating it as "removed".
    """
    if not alembic_helpers.include_object(object, name, type_, reflected, compare_to):
        return False
    if type_ == "table" and reflected and compare_to is None:
        return False
    return True


def get_url() -> str:
    """Resolve the sync DB URL Alembic should use.

    DATABASE_URL in .env is async (`+asyncpg`) and points at the docker-compose
    service hostname `postgres`, which only resolves inside the compose network.
    Alembic runs synchronously as a host process, so: swap the driver for the
    already-installed psycopg2, and rewrite the hostname to localhost (Postgres's
    port is published to localhost:5432). ALEMBIC_DATABASE_URL can override this
    entirely if set.
    """
    url = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get(
        "DATABASE_URL", "postgresql://postgres:adaptivemap@localhost:5432/adaptivemap"
    )
    url = url.replace("postgresql+asyncpg://", "postgresql+psycopg2://")
    url = url.replace("@postgres:5432", "@localhost:5432")
    return url


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
        render_item=alembic_helpers.render_item,
        process_revision_directives=alembic_helpers.writer,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = get_url()
    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=include_object,
            render_item=alembic_helpers.render_item,
            process_revision_directives=alembic_helpers.writer,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
