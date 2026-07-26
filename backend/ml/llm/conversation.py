"""Pre-journey conversation logic — prompts + extraction, provider-agnostic.

Adapted from the roadmap's Week 9-10 Claude wrapper, written against the
LLMClient seam instead of a specific SDK. Two tasks:

1. generate_pre_journey_message — the single smart opener before a trip
   (<=30 words, <=1 question, grounded in the journey profile).
2. interpret_reply — parse the user's reply into structured signals: a trip
   intent (hurry/explore) that re-routes immediately, and durable preference
   updates that persist to user_preferences. Low-confidence extractions are
   dropped rather than applied.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from ml.llm.base import LLMClient, LLMUnavailable

# Below this, preference_updates are discarded (intent still passes through —
# it only affects one trip, so the cost of a wrong guess is low; a persisted
# preference is durable and needs more certainty).
CONFIDENCE_FLOOR = 0.5

_PREF_KEYS = {"avoid_highways", "avoid_tolls", "avoid_left_turns", "prefer_scenic"}

# Categories the assistant may request a stop for. Subset of PlaceCategory
# values — the vocabulary the extractor prompt advertises and the endpoint
# validates against.
STOP_CATEGORIES = {
    "cafe", "restaurant", "fuel", "ev_charging", "grocery", "park", "parking", "lodging",
}

PRE_JOURNEY_SYSTEM = """You are the driving assistant inside Gloway, a navigation app.
Before a trip starts you say ONE brief, warm, useful thing.

Rules:
1. Under 30 words. The user is about to drive.
2. At most ONE question. If nothing is worth asking, just be helpful or encouraging.
3. Use the profile and trip context provided. Never ask about something the profile already answers.
4. No jargon, no bullet points, no emoji. Sound like a friend in the passenger seat."""

_REPLY_SYSTEM = """You extract structured driving signals from a user's reply to their navigation assistant, then write a short acknowledgement.

Respond with ONLY valid JSON matching:
{
  "intent": "hurry" | "explore" | null,      // for THIS trip only
  "preference_updates": {                     // durable, only when clearly stated
    "avoid_highways": true | false,           // include a key ONLY if the reply implies it
    "avoid_tolls": true | false,
    "avoid_left_turns": true | false,
    "prefer_scenic": true | false
  },
  "switch_to_route": null | integer,          // index from ROUTE OPTIONS, only if the user asks to take a different option
  "add_stop": null | {                        // only if the user wants to stop somewhere on the way
    "category": null | "cafe" | "restaurant" | "fuel" | "ev_charging" | "grocery" | "park" | "parking" | "lodging",
    "query": null | "..."                     // a specific place NAME they said (e.g. "Panera"); else null
  },
  "remove_stops": true | false,               // true if they want to drop the planned stop(s)
  "set_destination": "home" | "work" | null,  // if they ask to go home / to work instead
  "travel_mode": "auto" | "bicycle" | "pedestrian" | null,  // if they say how they're travelling
  "assistant_reply": "...",                   // under 20 words, warm, no question
  "confidence": 0.0-1.0                       // how sure you are about preference_updates
}

"Running late" / "in a rush" => intent hurry. "No rush" / "taking it easy" / "show me something nice" => intent explore.
"I hate highways" => preference_updates.avoid_highways true. A one-off "avoid the highway today" is intent, NOT a durable preference.
"Grab a coffee on the way" => add_stop {"category": "cafe", "query": null}. "Stop at Panera" => add_stop {"category": "restaurant", "query": "Panera"}.
"Need gas" => add_stop {"category": "fuel"}. "Actually skip the stop" => remove_stops true.
"Take the slower/scenic/second one" => switch_to_route with the matching index from ROUTE OPTIONS (never invent an index).
"Take me home" => set_destination "home". "Head to work instead" => set_destination "work".
"I'm on my bike" / "cycling today" => travel_mode "bicycle". "I'm walking" / "on foot" => travel_mode "pedestrian". "Back in the car" => travel_mode "auto".
For add_stop, do NOT name a place in assistant_reply — the app appends the found place itself."""


@dataclass
class StopRequest:
    category: str | None = None  # a STOP_CATEGORIES value
    query: str | None = None     # specific place name the user said


@dataclass
class ReplyInterpretation:
    intent: str | None = None
    preference_updates: dict = field(default_factory=dict)
    switch_to_route: int | None = None
    add_stop: StopRequest | None = None
    remove_stops: bool = False
    set_destination: str | None = None   # "home" | "work"
    travel_mode: str | None = None       # "auto" | "bicycle" | "pedestrian"
    assistant_reply: str = "Got it."
    confidence: float = 0.0


def _profile_block(journey: dict, prefs: dict, trip_context: dict) -> str:
    return f"""USER PROFILE:
- Conversation style: {journey.get('preferred_convo_style', 'brief')} (silent = keep it to bare essentials)
- Typical use cases: {journey.get('typical_use_cases') or 'unknown'}
- Stated dislikes: {journey.get('stated_dislikes') or 'none stated'}
- Routing preferences already set: {[k for k, v in prefs.items() if v is True] or 'none'}

TRIP CONTEXT:
- From: {trip_context.get('origin_label') or 'current location'}
- To: {trip_context.get('dest_label') or 'destination'}
- Local time: {trip_context.get('local_time', 'unknown')}

Write your single opening message for this trip."""


async def generate_pre_journey_message(
    client: LLMClient, journey: dict, prefs: dict, trip_context: dict
) -> str:
    text = await client.complete(
        system=PRE_JOURNEY_SYSTEM,
        messages=[{"role": "user", "content": _profile_block(journey, prefs, trip_context)}],
        max_tokens=100,
    )
    return text.strip()


async def interpret_reply(
    client: LLMClient,
    messages: list[dict],
    user_reply: str,
    route_options: list[dict] | None = None,
) -> ReplyInterpretation:
    transcript = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in messages)
    options_block = ""
    if route_options:
        lines = "\n".join(
            f"  {opt['index']}: {round(opt['minutes'])} min"
            + (" (currently selected)" if opt.get("selected") else "")
            for opt in route_options
        )
        options_block = f"\nROUTE OPTIONS:\n{lines}\n"
    prompt = f"""CONVERSATION SO FAR:
{transcript}
{options_block}
USER'S NEW REPLY:
{user_reply}

Extract signals and write the acknowledgement."""

    raw = await client.complete(
        system=_REPLY_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=300,
        json_mode=True,
    )
    return _parse_reply_data(raw)


def _parse_reply_data(raw: str) -> ReplyInterpretation:
    """Parse the shared action-extraction JSON into a ReplyInterpretation.

    Used by both interpret_reply (pre-trip) and interpret_navigation_reply
    (in-drive), which advertise the same JSON schema — so the leniency rules
    (confidence floor on durable prefs, enum validation, malformed-field
    fallthrough) live in one place. Range validation of switch_to_route stays
    in the endpoint/handler, which alone knows how many options actually exist.
    """
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise LLMUnavailable(f"extractor returned non-JSON: {raw[:120]}") from exc

    intent = data.get("intent")
    if intent not in ("hurry", "explore"):
        intent = None
    confidence = float(data.get("confidence") or 0.0)
    updates_raw = data.get("preference_updates") or {}
    updates = {
        k: bool(v)
        for k, v in updates_raw.items()
        if k in _PREF_KEYS and isinstance(v, bool)
    }
    if confidence < CONFIDENCE_FLOOR:
        updates = {}

    switch_raw = data.get("switch_to_route")
    switch_to_route = switch_raw if isinstance(switch_raw, int) and switch_raw >= 0 else None

    add_stop = None
    stop_raw = data.get("add_stop")
    if isinstance(stop_raw, dict):
        category = stop_raw.get("category")
        query = stop_raw.get("query")
        category = category if category in STOP_CATEGORIES else None
        query = str(query).strip() if isinstance(query, str) and query.strip() else None
        if category or query:
            add_stop = StopRequest(category=category, query=query)

    dest = data.get("set_destination")
    set_destination = dest if dest in ("home", "work") else None
    mode = data.get("travel_mode")
    travel_mode = mode if mode in ("auto", "bicycle", "pedestrian") else None

    reply = str(data.get("assistant_reply") or "Got it.").strip()
    return ReplyInterpretation(
        intent=intent,
        preference_updates=updates,
        switch_to_route=switch_to_route,
        add_stop=add_stop,
        remove_stops=bool(data.get("remove_stops")),
        set_destination=set_destination,
        travel_mode=travel_mode,
        assistant_reply=reply,
        confidence=confidence,
    )


# --- In-navigation voice (Week 13-14) ------------------------------------
# Same action schema as _REPLY_SYSTEM, but the user is mid-drive and speaking,
# so assistant_reply may directly ANSWER a question ("how long left?", "what's
# my next turn?") using the NAV CONTEXT block, and every reply is kept short
# enough to hear over road noise. Actions still apply live (full parity with
# the pre-trip reply): stops, reroute, destination, mode, intent, prefs.

_NAVIGATION_SYSTEM = """You are Gloway's in-car voice assistant. The user is DRIVING right now and speaking to you hands-free. Use the NAV CONTEXT to answer questions, and extract any driving command they give.

Respond with ONLY valid JSON matching:
{
  "intent": "hurry" | "explore" | null,      // for the REST of this trip only
  "preference_updates": {                     // durable, only when clearly stated
    "avoid_highways": true | false,           // include a key ONLY if the reply implies it
    "avoid_tolls": true | false,
    "avoid_left_turns": true | false,
    "prefer_scenic": true | false
  },
  "switch_to_route": null | integer,          // index from ROUTE OPTIONS, only if they ask for a different option
  "add_stop": null | {                        // only if they want to stop somewhere on the way
    "category": null | "cafe" | "restaurant" | "fuel" | "ev_charging" | "grocery" | "park" | "parking" | "lodging",
    "query": null | "..."                     // a specific place NAME they said; else null
  },
  "remove_stops": true | false,               // true if they want to drop the planned stop(s)
  "set_destination": "home" | "work" | null,  // if they ask to go home / to work instead
  "travel_mode": "auto" | "bicycle" | "pedestrian" | null,  // only if they explicitly say how they're travelling
  "assistant_reply": "...",                   // under 20 words, spoken aloud; ANSWER their question here using NAV CONTEXT, or acknowledge the command
  "confidence": 0.0-1.0                       // how sure you are about preference_updates
}

Answer informational questions directly in assistant_reply from NAV CONTEXT: "how long / how far / are we close" => use minutes remaining and progress; "what's my next turn / where do I go" => use the next maneuver; "where am I going" => the destination. If NAV CONTEXT lacks the answer, say you're not sure rather than inventing one.
"Find gas" / "I need a coffee" => add_stop. "Actually skip that stop" => remove_stops true.
"Take me home" => set_destination "home". "Take the faster one" => switch_to_route with the matching ROUTE OPTIONS index (never invent an index).
For add_stop, do NOT name a place in assistant_reply — the app appends the found place itself.
Do not chat; keep it to answering or confirming. No emoji."""


def _nav_context_block(nav_context: dict) -> str:
    """Render the client-supplied live nav state for the prompt.

    The client owns these values (it already computes progress, ETA, and the
    current step for the trip panel), so the handler passes them through rather
    than re-deriving them from the stored Valhalla payload.
    """
    progress = nav_context.get("progress")
    progress_pct = f"{round(float(progress) * 100)}%" if isinstance(progress, (int, float)) else "unknown"
    minutes = nav_context.get("minutesRemaining")
    minutes_txt = f"{round(float(minutes))} min" if isinstance(minutes, (int, float)) else "unknown"
    return f"""NAV CONTEXT (live):
- Destination: {nav_context.get('destLabel') or 'their destination'}
- Progress along route: {progress_pct}
- Time remaining: {minutes_txt}
- Next maneuver: {nav_context.get('nextManeuver') or 'unknown'}"""


async def interpret_navigation_reply(
    client: LLMClient,
    messages: list[dict],
    user_reply: str,
    nav_context: dict,
    route_options: list[dict] | None = None,
) -> ReplyInterpretation:
    """Parse a spoken utterance mid-drive into an answer + action set.

    Superset of interpret_reply: the model may answer informational questions
    from nav_context, and the same JSON action schema is parsed by the shared
    _parse_reply_data. `nav_context` keys (all client-supplied): destLabel,
    progress (0..1), minutesRemaining, nextManeuver.
    """
    transcript = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in messages)
    options_block = ""
    if route_options:
        lines = "\n".join(
            f"  {opt['index']}: {round(opt['minutes'])} min"
            + (" (currently selected)" if opt.get("selected") else "")
            for opt in route_options
        )
        options_block = f"\nROUTE OPTIONS:\n{lines}\n"
    prompt = f"""{_nav_context_block(nav_context)}
{options_block}
CONVERSATION SO FAR:
{transcript or '(none yet)'}

USER JUST SAID (while driving):
{user_reply}

Answer or extract the command, and write the spoken reply."""

    raw = await client.complete(
        system=_NAVIGATION_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=300,
        json_mode=True,
    )
    return _parse_reply_data(raw)


# --- Post-trip debrief ---------------------------------------------------

POST_JOURNEY_SYSTEM = """You are Gloway's driving assistant, greeting the user just after they finished a trip.
Ask ONE short, warm question about how the drive went.

Rules:
1. Under 15 words. One question only.
2. Reference the trip if it helps (destination), but don't interrogate.
3. No jargon, no emoji. Sound like a friend who was riding along."""

_DEBRIEF_EXTRACT_SYSTEM = """You read a user's reply about a drive that just ended, then extract a reward signal and any durable preferences, and write a brief acknowledgement.

Respond with ONLY valid JSON matching:
{
  "reward_delta": -1.0 to 1.0,   // how good the route was, from their sentiment. Happy/smooth = positive, frustrated/bad = negative, neutral = ~0
  "preference_updates": {         // durable, only when clearly implied
    "avoid_highways": true | false,
    "avoid_tolls": true | false,
    "avoid_left_turns": true | false,
    "prefer_scenic": true | false
  },
  "assistant_reply": "...",       // under 15 words, warm, no question
  "confidence": 0.0-1.0           // confidence in preference_updates
}

"That was lovely / smooth / great" => reward_delta ~0.8. "Traffic was awful / hated it" => reward_delta ~-0.8.
"The scenic way was nice, let's do that more" => prefer_scenic true. "Too many highways" => avoid_highways true."""


@dataclass
class DebriefInterpretation:
    reward_delta: float = 0.0
    preference_updates: dict = field(default_factory=dict)
    assistant_reply: str = "Thanks for the feedback."
    confidence: float = 0.0


async def generate_debrief_question(
    client: LLMClient, journey: dict, trip_context: dict
) -> str:
    block = f"""The user just finished a drive to {trip_context.get('dest_label') or 'their destination'}.
Conversation style: {journey.get('preferred_convo_style', 'brief')}.
Ask your one short question about how it went."""
    text = await client.complete(
        system=POST_JOURNEY_SYSTEM,
        messages=[{"role": "user", "content": block}],
        max_tokens=60,
    )
    return text.strip()


async def interpret_debrief(
    client: LLMClient, question: str, user_reply: str
) -> DebriefInterpretation:
    prompt = f"""ASSISTANT ASKED:
{question}

USER REPLIED:
{user_reply}

Extract the reward signal and any durable preferences, and acknowledge."""
    raw = await client.complete(
        system=_DEBRIEF_EXTRACT_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=300,
        json_mode=True,
    )
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise LLMUnavailable(f"debrief extractor returned non-JSON: {raw[:120]}") from exc

    reward = float(data.get("reward_delta") or 0.0)
    reward = max(-1.0, min(1.0, reward))
    confidence = float(data.get("confidence") or 0.0)
    updates_raw = data.get("preference_updates") or {}
    updates = {
        k: bool(v)
        for k, v in updates_raw.items()
        if k in _PREF_KEYS and isinstance(v, bool)
    }
    if confidence < CONFIDENCE_FLOOR:
        updates = {}
    reply = str(data.get("assistant_reply") or "Thanks for the feedback.").strip()
    return DebriefInterpretation(
        reward_delta=reward,
        preference_updates=updates,
        assistant_reply=reply,
        confidence=confidence,
    )
