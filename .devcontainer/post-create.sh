#!/usr/bin/env bash
set -e

if [ ! -f .env ]; then
  cp .env.example .env
fi

bun install

echo "Devcontainer ready. Run: bun run dev"
