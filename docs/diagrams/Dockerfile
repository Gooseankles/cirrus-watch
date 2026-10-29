# The renderer for the architecture pictures: docs/diagrams/*.py are Python
# "diagrams" sources (https://diagrams.mingrammer.com, MIT) that draw with the
# official Microsoft Azure architecture icons the library ships, through Graphviz.
# scripts/diagrams.mjs builds this image the first time it is needed (tagged with
# this file's fingerprint, so a change here is a rebuild) and runs one source per
# container; nobody needs Python or Graphviz installed. Pinned by digest like the
# app's own Dockerfile. The library lists pre-commit as a run-time dependency by
# mistake, so its real dependencies are installed by name instead.
FROM python:3.13.18-slim@sha256:76baad6037690d6e8c4397fbcaef17bca6f19eecef822b708fe8fa3417d30bb5
RUN apt-get update \
  && apt-get install -y --no-install-recommends graphviz fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --no-deps diagrams==0.25.1 graphviz==0.20.3 jinja2==3.1.6 MarkupSafe==3.0.3
WORKDIR /data
ENTRYPOINT ["python"]
