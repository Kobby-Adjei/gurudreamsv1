# TEMPORARY smoke-test client (deploy/railway/README.md). Build context: repository root.
FROM golang:1.27-bookworm AS net
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto GOFLAGS=-mod=readonly
WORKDIR /src
COPY desktop/sidecar/airbridge-net ./
RUN go build -trimpath -ldflags "-s -w" -o /out/airbridge-net .

FROM python:3.12-slim-bookworm
COPY airbridge/requirements.txt /app/airbridge/requirements.txt
RUN pip install --no-cache-dir -r /app/airbridge/requirements.txt
COPY airbridge/main.py /app/airbridge/main.py
COPY airbridge/airbridge_app /app/airbridge/airbridge_app
COPY --from=net /out/airbridge-net /usr/local/bin/airbridge-net
COPY deploy/railway/smoke/smoke.py deploy/railway/smoke/probe.py /app/
RUN useradd -m smoke
USER smoke
CMD ["python", "/app/smoke.py"]
