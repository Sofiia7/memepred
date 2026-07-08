# Single image used for both `backend` (API) and `keeper` (worker) services.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false
COPY . .
RUN npm run build || npx tsc -p tsconfig.json

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/db/migrations ./dist/db/migrations
# node:20-alpine ships a built-in unprivileged `node` user (uid 1000) —
# both the backend and keeper services use this same image, neither needs root.
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
