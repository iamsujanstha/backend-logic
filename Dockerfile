# Stage 1: Base Dependencies
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ==========================================
# NEW STAGE: Development Runtime (For Watch Mode)
# ==========================================
FROM node:20-alpine AS development
WORKDIR /app
# Copy dependencies and full source code for hot-reloading
COPY --from=base /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# Stage 3: Build the production assets
FROM base AS build
WORKDIR /app
COPY . .
RUN npm run build

# Stage 4: Production Runtime
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
