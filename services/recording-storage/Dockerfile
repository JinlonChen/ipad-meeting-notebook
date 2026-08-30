FROM docker.m.daocloud.io/library/python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY services/recording-storage/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && addgroup --system storage \
    && adduser --system --ingroup storage storage \
    && mkdir -p /data \
    && chown -R storage:storage /data
COPY services/recording-storage/app.py ./app.py
COPY services/transcription-relay/relay ./relay
RUN chown -R storage:storage /app
USER storage
EXPOSE 8100
CMD ["uvicorn", "app:create_production_app", "--factory", "--host", "0.0.0.0", "--port", "8100", "--no-access-log"]
