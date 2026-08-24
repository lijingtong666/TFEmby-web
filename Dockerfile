# syntax=docker/dockerfile:1
ARG PYTHON_VERSION=3.12

FROM python:${PYTHON_VERSION}-alpine AS runtime-alpine
WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=8099 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY app.py /app/app.py
COPY public /app/public
EXPOSE 8099
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8099/api/status', timeout=3).read()"
CMD ["python", "app.py"]

FROM python:${PYTHON_VERSION}-slim AS runtime-slim
WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=8099 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY app.py /app/app.py
COPY public /app/public
EXPOSE 8099
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8099/api/status', timeout=3).read()"
CMD ["python", "app.py"]

FROM runtime-alpine AS final
