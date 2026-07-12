FROM node:24-alpine
WORKDIR /app
ENV NODE_PATH=/app/node_modules
COPY workers/provisioner/package.json workers/provisioner/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY tsconfig.base.json /tsconfig.base.json
COPY workers/provisioner/ ./
COPY agent-runtime /agent-runtime
COPY backend-api /backend-api
# worker.ts imports backend-api helpers whose transitive runtime dependencies
# are not part of the provisioner package. Keep the development/E2E image
# self-contained just like Dockerfile.prod instead of relying on host modules.
RUN cd /backend-api && (npm ci --omit=dev || npm install --omit=dev)
CMD ["npm", "start"]
