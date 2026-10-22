# The statcan2.ca server. Build from the repo root: the API reads api/ and data/ref/.
# The data (Clean builds, normalized series, code sets) is mounted at /data at run time; see api/README.md.
FROM node:26.12.1-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci --omit=dev && npx playwright install --with-deps --only-shell chromium && chmod -R a+rX /ms-playwright
COPY api/src ./src
COPY api/public ./public
COPY data/ref /app/data/ref
ENV NODE_ENV=production HOST=:: PORT=3000 \
    STATCAN_BUILD=/data/wds-full-1 \
    STATCAN_NORMALIZED=/data/wds-full-1/normalized/n8 \
    STATCAN_CODESETS=/data/codesets/codeSets.json \
    STATCAN_EMBEDDINGS=/app/data/ref/table-embeddings.parquet
EXPOSE 3000
USER node
CMD ["node", "src/index.ts"]
