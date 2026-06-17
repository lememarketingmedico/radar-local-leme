FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmjs.org/

COPY . .
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
