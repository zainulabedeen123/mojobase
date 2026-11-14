# Mojobase console: web app + API + project provisioner.
# Talks to the host Docker daemon through a mounted /var/run/docker.sock.
FROM node:24-alpine
RUN apk add --no-cache docker-cli docker-cli-compose tini
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 INTERNAL_PORT=3001
VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
