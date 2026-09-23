FROM node:22-alpine
WORKDIR /app
COPY server.js /app/server.js
RUN node --check /app/server.js
EXPOSE 3100
CMD ["node", "/app/server.js"]
