FROM docker.m.daocloud.io/library/python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY services/transcription-relay/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && addgroup --system relay \
    && adduser --system --ingroup relay relay

COPY services/transcription-relay/relay ./relay
RUN chown -R relay:relay /app

USER relay
EXPOSE 8000

CMD ["uvicorn", "relay.app:create_production_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
