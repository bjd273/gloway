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
    Time,
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


class UserJourneyProfile(Base):
    """Phase 2 profile: onboarding facts + patterns learned over time.

    This is what the LLM conversation layer reads before every trip (and what
    Phase 3's similar-user bootstrapping queries by home/work proximity —
    hence the spatial indexes). Distinct from UserPreference, which holds the
    routing weights injected into Valhalla costing.
    """

    __tablename__ = "user_journey_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )

    # From onboarding
    typical_use_cases: Mapped[list | None] = mapped_column(ARRAY(Text), nullable=True)
    stated_dislikes: Mapped[list | None] = mapped_column(ARRAY(Text), nullable=True)
    home_location = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=True), nullable=True
    )
    work_location = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=True), nullable=True
    )

    # Learned over time
    known_regular_routes: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb")
    )
    driving_persona: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    preferred_convo_style: Mapped[str] = mapped_column(String(20), server_default=text("'brief'"))

    # Context patterns (learned)
    morning_routine_start_time: Mapped[object | None] = mapped_column(Time, nullable=True)
    typical_commute_duration_mins: Mapped[int | None] = mapped_column(Integer, nullable=True)

    updated_at: Mapped[object] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("NOW()")
    )


class TripConversation(Base):
    """Per-trip conversation history — LLM context + extraction target."""

    __tablename__ = "trip_conversations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    trip_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("trips.id"), nullable=False
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    messages: Mapped[list] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    # A *list* of per-reply extractions, appended in order — not a single dict.
    # It was a dict originally, overwritten on every reply, which silently
    # discarded everything but the last turn. The `switch_to_route` field in
    # particular is a pairwise preference label ("shown these options, chose
    # #2") and the strongest training signal the conversation produces, so it
    # has to survive every turn. JSONB stores arrays natively, so widening this
    # needs no migration; pre-existing rows are NULL and stay NULL.
    preference_updates_extracted: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[object] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("NOW()")
    )

    __table_args__ = (
        Index("idx_trip_conversations_trip_id", "trip_id"),
        Index("idx_trip_conversations_user_id", "user_id"),
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
