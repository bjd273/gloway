# Adaptive Map — Startup Context & Problem Statement

## The Problem
Google Maps and Apple Maps dominate navigation with a 90%+ market share. They update maps slowly using expensive fleet operations (cars with cameras driving everywhere). Users have zero control over routing — the algorithm decides, and it's optimized for the crowd, not for you.

## Our Solution
**Personalized adaptive routing powered by RL + crowdsourced real-time map updates.**

Build a mapping platform where:
1. **The router learns you.** Every trip teaches the system your preferences (you hate highways, you prefer scenic routes, you're always late). The more you drive, the better it gets. No two users get the same route — it's uniquely optimized for *you*.

2. **Maps update in real-time from dashcams.** Instead of Google sending expensive fleet cars, we use dashcams as crowdsourced sensors. A user's dashcam detects a new road, speed limit change, or traffic sign → instantly updates the map for everyone. Millions of dashcams = better, fresher maps than any company can build.

3. **The experience is conversational.** Before every trip, the app asks one smart contextual question: "Running late?" "Want to explore?" Its answer changes the route. After the trip, brief feedback ("that route was stressful") teaches the system. No forms, no friction — just a conversation.

## Technical Approach

### Phase 1 (Weeks 1–8): Base Router
- Route planner on top of OpenStreetMap + Valhalla
- PostgreSQL + PostGIS for spatial queries
- Rule-based user preferences (avoid highways, tolls, etc.)
- React + MapLibre GL frontend
- **Goal:** Ship a working map that's faster/cleaner than competitors

### Phase 2 (Weeks 9–16): LLM Conversation Layer
- Claude API for smart contextual questions before trips
- Voice I/O (Whisper STT + Coqui TTS)
- Post-trip feedback extraction (convert "that was stressful" into structured preference signals)
- **Goal:** Make the experience feel like a personal driving assistant, not a navigation app

### Phase 3 (Weeks 17–28): RL Personalization
- Graph Neural Network encodes the road network
- Reinforcement Learning model learns route preferences per user
- Federated learning improves the base model across all users without sharing raw data
- User preference embeddings (small, updatable vectors per user)
- **Goal:** Routes become genuinely personalized — each user's model reflects their unique driving style

## Why This Works
- **Viral loop:** Every user's dashcam = map data, so maps improve for everyone. Better maps = more users.
- **Network effects:** 1,000 drivers → crowd-sourced real-time map updates that beat Google's 30-day lag.
- **Defensible moat:** Learning user preferences is hard; doing it via RL from real driving behavior (not surveys) is novel and defensible.
- **Hardware angle (Phase 4+):** Once the software is undeniable, integrate a branded dashcam that runs our ML for ADAS (lane detection, pedestrian alerts, etc.) — turns customers into data collectors.

## Team
- **You:** Path planning expert (autonomous vehicles), ML/RL architect, edge ML
- **Jonathan:** Full-stack backend/frontend engineer, infrastructure

## Success Metrics (Year 1)
- 10k active users doing 50k+ routes/month
- Map updates latency < 1 hour for major changes (vs. Google's 30 days)
- Route personalization measurably saves users 5+ min per trip on average
- User retention > 60% (comparison: Waze is ~70%)

## One-Sentence Pitch
"Google Maps, but the routing learns *you*, and the maps update from a million dashcams in real-time instead of a fleet of cars."
