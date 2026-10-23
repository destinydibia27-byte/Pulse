# One container runs the web app AND the worker. They share a JSON database file, so they must
# live in the same container with the same disk (a platform disk can attach to only one service).
FROM node:22-slim
WORKDIR /app

# Public values are baked into the browser bundle at BUILD time, so they are passed as build args.
# Set them as service variables with the same names; the platform hands them to the build.
ARG NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS
ARG NEXT_PUBLIC_USDC_ADDRESS
ARG NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL
ARG NEXT_PUBLIC_ZERODEV_PROJECT_ID
ENV NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS=$NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS \
    NEXT_PUBLIC_USDC_ADDRESS=$NEXT_PUBLIC_USDC_ADDRESS \
    NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL=$NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL \
    NEXT_PUBLIC_ZERODEV_PROJECT_ID=$NEXT_PUBLIC_ZERODEV_PROJECT_ID

COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --no-audit --no-fund
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --no-audit --no-fund

COPY . .
RUN cd frontend && npm run build

ENV NODE_ENV=production \
    PULSE_DB_PATH=/data/automations.json
EXPOSE 3000
CMD ["bash", "scripts/start-hosted.sh"]
