import uuid

from geoalchemy2 import Geography
from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    TIMESTAMP,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    created_at: Mapped[object] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("NOW()")
    )
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, server_default=text("FALSE"))


class UserPreference(Base):
    __tablename__ = "user_preferences"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    avoid_highways: Mapped[bool] = mapped_column(Boolean, server_default=text("FALSE"))
    avoid_tolls: Mapped[bool] = mapped_column(Boolean, server_default=text("FALSE"))
    avoid_left_turns: Mapped[bool] = mapped_column(Boolean, server_default=text("FALSE"))
    prefer_scenic: Mapped[bool] = mapped_column(Boolean, server_default=text("FALSE"))
    max_acceptable_detour_minutes: Mapped[int] = mapped_column(Integer, server_default=text("5"))
    preference_vector: Mapped[list | None] = mapped_column(ARRAY(Float), nullable=True)
    updated_at: Mapped[object] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("NOW()")
    )


class Trip(Base):
    __tablename__ = "trips"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    origin = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=True), nullable=False
    )
    destination = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=True), nullable=False
    )
    suggested_route: Mapped[dict] = mapped_column(JSONB, nullable=False)
    actual_path_taken: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[object] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("NOW()")
    )
    completed_at: Mapped[object | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    context: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    implicit_signals: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    explicit_feedback: Mapped[str | None] = mapped_column(Text, nullable=True)
    reward_value: Mapped[float | None] = mapped_column(Float, nullable=True)

    __table_args__ = (Index("idx_trips_user_id", "user_id"),)


class RoadSegment(Base):
    __tablename__ = "road_segments"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    osm_way_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    geom = mapped_column(
        Geography(geometry_type="LINESTRING", srid=4326, spatial_index=True), nullable=False
    )
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    highway_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    speed_limit_kph: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lanes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    one_way: Mapped[bool] = mapped_column(Boolean, server_default=text("FALSE"))
    last_verified_at: Mapped[object] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("NOW()")
    )
    confidence_score: Mapped[float] = mapped_column(Float, server_default=text("1.0"))
