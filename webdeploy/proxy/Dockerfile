FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=7171
EXPOSE 7171
CMD ["node", "server.js"]
