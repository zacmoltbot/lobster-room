# Lobster Room (OpenClaw Dashboard fork) — Docker image for Zeabur
# Runs the lightweight python server that serves static files + APIs.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Copy everything (repo is small; no extra deps needed)
COPY . /app

# Default port (platform usually injects PORT)
EXPOSE 8080

# Run the dashboard server. server.py will read PORT env automatically.
CMD ["python3", "server.py"]
