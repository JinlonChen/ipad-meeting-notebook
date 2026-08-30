FROM docker.m.daocloud.io/library/python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODELSCOPE_CACHE=/models

WORKDIR /app
COPY services/diarization-sidecar/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && addgroup --system diarization \
    && adduser --system --ingroup diarization diarization \
    && mkdir -p /models \
    && chown -R diarization:diarization /models
COPY services/diarization-sidecar/app.py ./app.py
RUN chown -R diarization:diarization /app
USER diarization
EXPOSE 8001
CMD ["uvicorn", "app:create_production_app", "--factory", "--host", "0.0.0.0", "--port", "8001", "--no-access-log"]
