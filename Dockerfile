# The statcan2.ca server. Build from the repo root: the API reads api/ and data/ref/.
# The data (Clean builds, normalized series, code sets) is mounted at /data at run time; see api/README.md.
FROM node:26-slim
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev
COPY api/src ./src
COPY api/public ./public
COPY data/ref /app/data/ref
ENV NODE_ENV=production HOST=:: PORT=3000 \
    STATCAN_BUILD=/data/wds-full-1 \
    STATCAN_NORMALIZED=/data/wds-full-1/normalized/n8 \
    STATCAN_CODESETS=/data/codesets/codeSets.json
EXPOSE 3000
USER node
CMD ["node", "src/index.ts"]
