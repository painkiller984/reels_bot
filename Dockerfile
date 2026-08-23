FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json prisma.config.ts ./
RUN npm ci
COPY src ./src
COPY tests ./tests
COPY prisma ./prisma
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV APP_ENV=production
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/artifacts /app/.data && chown -R node:node /app
USER node
CMD ["sh", "-c", "npm run db:deploy && node dist/src/main.js"]
