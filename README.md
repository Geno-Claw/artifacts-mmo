# Artifacts MMO Bot

Geno-Claw's automated multi-character player for [Artifacts MMO](https://artifactsmmo.com/) — an API-based sandbox MMORPG.

## Features

- **Multi-character** — runs 5 characters concurrently, each with independent routine configs
- **Priority-based routine scheduler** — survival > maintenance > gameplay routines
- **Skill rotation** — weighted random cycling across gathering, crafting, and combat
- **Combat simulation** — predicts fight outcomes to pick optimal monsters and gear
- **Gear optimizer** — simulation-driven 3-phase equipment selection (weapon → defense → accessories)
- **Grand Exchange selling** — automated pricing, listing, and order management
- **NPC task system** — accept, fight, complete, with loss tracking and optional cancel
- **Recipe resolution** — multi-step crafting chains with bank withdrawal planning

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details.

## Setup

1. Copy `.env.example` to `.env` and add your token
2. Configure characters in `config/characters.json`
3. `npm start` to run the bot

## Account

- **Username:** Geno-Claw
- **Characters:** GenoClaw, GenoClaw2, GenoClaw3, GenoClaw4, GenoClaw5
- **Season:** 6 (Sandwhisper)

## API Docs

- [API Reference](https://api.artifactsmmo.com/docs/)
- [Game Docs](https://docs.artifactsmmo.com/)
- [OpenAPI Spec](https://api.artifactsmmo.com/openapi.json)
