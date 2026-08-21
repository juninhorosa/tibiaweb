FROM node:22-alpine
RUN apk add --no-cache curl unzip
WORKDIR /app
COPY serve.mjs entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENV PORT=8080
ENV CLIENT_DIR=/client/build-emscripten-web
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
