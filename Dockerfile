FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache fontconfig ttf-dejavu

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmjs.org/

COPY . .
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
